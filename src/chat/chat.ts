import { chatModels, connFrom, generateJSONFast } from '../ai/gemini';
import { findEntry, normalize } from '../dict/lookup';
import { db, type Level, type Settings } from '../db/schema';
import { rate, Rating } from '../srs';
import type { Scenario } from './scenarios';

// Conversation practice. Gemini plays a role and steers the talk toward the learner's saved
// words; a word the learner uses correctly counts as an FSRS "Good" on its recall (ko→en) card,
// once per chat. Credit is only given when the word really appears in the learner's message.

export interface Target {
  key: string;
  display: string;
  ko: string[];
}

export interface Turn {
  role: 'user' | 'model';
  text: string; // English (what was said)
  ko?: string; // model turns: Korean translation
  correction?: { original: string; better: string; note: string };
  credited?: string[]; // user turns: target words logged as reviews
  hint?: string; // model turns: Korean hint for what to say next
}

const MAX_TARGETS = 6;
const HISTORY_TURNS = 16;

/** Saved words to practice: recall cards that are due first, then other learning words. */
export async function pickTargets(): Promise<Target[]> {
  const words = (await db.myWords.toArray()).filter((w) => w.status !== 'archived');
  const recall = new Map((await db.cards.where('word').anyOf(words.map((w) => w.word)).toArray())
    .filter((c) => c.dir === 'ko2en').map((c) => [c.word, c.due.getTime()]));
  const now = Date.now();
  const score = (w: (typeof words)[number]) =>
    (recall.get(w.word) ?? Infinity) <= now ? 0 : w.status === 'learning' ? 1 : 2;
  return words
    .sort((a, b) => score(a) - score(b) || (recall.get(a.word) ?? 0) - (recall.get(b.word) ?? 0) || Math.random() - 0.5)
    .slice(0, MAX_TARGETS)
    .map((w) => ({ key: w.word, display: w.display, ko: w.ko }));
}

const LEVEL_STYLE: Record<Level, string> = {
  beginner: 'very simple words and short sentences, as if talking to a beginner',
  intermediate: 'clear everyday English with common expressions',
  advanced: 'natural, fluent English at normal speed',
};

const STR = { type: 'STRING' };
const TURN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { ...STR, description: 'your next line, in character, 1–3 short sentences' },
    replyKo: { ...STR, description: 'natural Korean translation of reply' },
    correctionOriginal: { ...STR, description: "the learner's mistaken words, or empty" },
    correctionBetter: { ...STR, description: 'the corrected version, or empty' },
    correctionNoteKo: { ...STR, description: 'one short Korean sentence explaining it, or empty' },
    usedCorrectly: { type: 'ARRAY', items: STR, description: "target words used correctly in the learner's LAST message" },
    misused: { type: 'ARRAY', items: STR, description: "target words used incorrectly in the learner's LAST message" },
    hintKo: { ...STR, description: 'short Korean hint for what the learner could say next' },
  },
  required: ['reply', 'replyKo', 'correctionOriginal', 'correctionBetter', 'correctionNoteKo', 'usedCorrectly', 'misused', 'hintKo'],
  propertyOrdering: ['reply', 'replyKo', 'correctionOriginal', 'correctionBetter', 'correctionNoteKo', 'usedCorrectly', 'misused', 'hintKo'],
};

function systemPrompt(scenario: Scenario, targets: Target[], settings: Settings): string {
  const p = settings.profile;
  const learner = [p.ageRange && `in their ${p.ageRange}`, p.occupation && `works as: ${p.occupation}`].filter(Boolean).join(', ');
  return [
    `You are role-playing ${scenario.role}. The other person is a Korean adult learning English${learner ? ` (${learner})` : ''}.`,
    `Stay in character and never switch roles. Use ${LEVEL_STYLE[p.level]}. Keep each reply to 1–3 short sentences and usually end with a question.`,
    targets.length
      ? `Steer the conversation so the learner naturally needs these words: ${targets.map((t) => t.display).join(', ')}. ` +
        'Never list them or tell the learner to use them; create situations and questions where they fit.'
      : '',
    'If the learner\'s last message has a clear grammar or word-choice mistake, fill correctionOriginal / correctionBetter / ' +
      'correctionNoteKo with one short correction (ignore typos, capitalization and punctuation); otherwise leave them empty. ' +
      'Keep the conversation going in character after a correction.',
    'usedCorrectly: target words the learner used correctly (any form) in their LAST message only. misused: target words used wrongly.',
    'hintKo: one short Korean suggestion for what the learner could say next, nudging toward a target word they have not used yet ' +
      '(e.g. "월세(rent)를 언제 내야 하는지 물어보세요").',
  ].filter(Boolean).join('\n');
}

const OPENING = '(Start the conversation now: greet me and set the scene in one or two sentences, in character.)';

interface TurnResult {
  reply: string;
  replyKo: string;
  correctionOriginal: string;
  correctionBetter: string;
  correctionNoteKo: string;
  usedCorrectly: string[];
  misused: string[];
  hintKo: string;
}

/** Runs one exchange. `message` is the learner's new message, or null to have Gemini open the scene. */
export async function takeTurn(scenario: Scenario, targets: Target[], history: Turn[], message: string | null, settings: Settings) {
  const conn = connFrom(settings);
  const models = chatModels(settings.models);
  if (!conn || !models.length) throw new Error('unavailable');
  const past = history.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, text: t.text }));
  if (past[0]?.role === 'model') past.unshift({ role: 'user', text: OPENING });
  // The opening greeting is simple, so the fast Lite model goes first (≈0.6 s instead of 3 s+).
  const order = message === null ? [models[models.length - 1], ...models.slice(0, -1)] : models;
  const { data } = await generateJSONFast<TurnResult>(conn, {
    models: order,
    system: systemPrompt(scenario, targets, settings),
    history: past,
    prompt: message ?? OPENING,
    schema: TURN_SCHEMA,
    temperature: 0.8,
    thinkingLevel: 'low',
    timeoutMs: 8_000, // a stuck model shouldn't hold up the conversation
  });
  return data;
}

/** Target words that really appear in the learner's message (any inflection the dictionary knows). */
export async function presentTargets(message: string, targets: Target[]): Promise<Set<string>> {
  const text = ' ' + normalize(message).replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const tokens = [...new Set(text.trim().split(' ').filter(Boolean))];
  // Each token's possible base forms: itself, the dictionary's lemma (went → go), regular endings.
  const lemmasOf = new Map<string, Set<string>>();
  for (const tok of tokens) {
    const set = new Set([tok]);
    const f = await findEntry(tok);
    if (f.kind === 'found') {
      set.add(f.key);
      f.entry.of?.forEach((o) => set.add(o.toLowerCase()));
    }
    for (const [suf, rep] of [['ies', 'y'], ['ied', 'y'], ['es', ''], ['s', ''], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e']]) {
      if (tok.endsWith(suf) && tok.length > suf.length + 2) set.add(tok.slice(0, -suf.length) + rep);
    }
    lemmasOf.set(tok, set);
  }
  const found = new Set<string>();
  for (const t of targets) {
    const [head, ...rest] = t.key.split(' ');
    const tail = rest.join(' ');
    // Phrases: an inflected head followed by the rest ("gave up" for "give up").
    const hit = tokens.some((tok) => lemmasOf.get(tok)!.has(head) && (!tail || text.includes(` ${tok} ${tail} `)));
    if (hit) found.add(t.key);
  }
  return found;
}

/** Logs a correct use as a recall review (once per word per chat). */
export async function creditWord(key: string): Promise<void> {
  const w = await db.myWords.get(key);
  if (w && w.status !== 'archived') await rate(key, 'ko2en', Rating.Good, 'conversation');
}

export async function saveChat(id: number | undefined, scenario: string, turns: Turn[], wordsUsed: string[], startedAt: number): Promise<number> {
  const row = { scenario, messages: turns.map((t) => ({ role: t.role, text: t.text, meta: t })), wordsUsed, startedAt };
  if (id) {
    await db.chats.put({ ...row, id });
    return id;
  }
  return db.chats.add(row);
}
