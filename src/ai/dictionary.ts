import { aiNeeds } from '../dict/lookup';
import type { AiFill, DictEntry } from '../dict/types';
import { db, type Settings } from '../db/schema';
import { connFrom, generateJSON } from './gemini';

// Gemini fills gaps in the bundled dictionary. Each word is asked about at most once:
// the answer (even "not a word") is stored in aiEntries and reused forever.

export class AiUnavailable extends Error {}

const SYSTEM =
  'You are a careful English–Korean learner\'s dictionary for adult Korean speakers. ' +
  'Korean must be natural, standard Korean (no romanization). English examples must be short, ' +
  'everyday and natural (max 15 words), and each Korean translation must match its example. ' +
  'Return only what is requested; use empty arrays for anything not requested.';

const STR = { type: 'STRING' };
const FILL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN', description: 'false if this is not a real English word or phrase' },
    word: { ...STR, description: 'correct English spelling of the word or phrase' },
    ipa: { ...STR, description: 'US IPA between slashes, or empty' },
    meanings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          p: { ...STR, description: 'part of speech in English: noun, verb, adj, adv, phrase, …' },
          g: { ...STR, description: 'short English definition' },
          ko: { type: 'ARRAY', items: STR, description: '1–3 Korean equivalents, dictionary style (e.g. 지원하다)' },
        },
        required: ['p', 'g', 'ko'],
        propertyOrdering: ['p', 'g', 'ko'],
      },
    },
    examples: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { en: STR, ko: STR },
        required: ['en', 'ko'],
        propertyOrdering: ['en', 'ko'],
      },
    },
    synonyms: { type: 'ARRAY', items: STR },
  },
  required: ['found', 'word', 'ipa', 'meanings', 'examples', 'synonyms'],
  propertyOrdering: ['found', 'word', 'ipa', 'meanings', 'examples', 'synonyms'],
};

function fillPrompt(key: string, entry: DictEntry | null, needs: ReturnType<typeof aiNeeds>): string {
  const lines = [`Word or phrase: "${key}"`];
  if (entry) {
    const senses = entry.pos.flatMap((b) => b.s.map((s) => `- (${b.p}) ${s.g}`)).slice(0, 6);
    lines.push('Known English senses:', ...senses);
  }
  lines.push('', 'Fill in:');
  if (needs.includes('all')) {
    lines.push(
      '- found, word, ipa',
      '- meanings: the 1–4 most common meanings, each with a short English definition and Korean equivalents',
      '- examples: 3 example sentences with Korean translations',
      '- synonyms: 3–5 common synonyms',
    );
  } else {
    lines.push('- found: true, word: the word as given');
    if (needs.includes('meanings')) lines.push('- meanings: Korean equivalents for the 1–4 most common senses listed above');
    if (needs.includes('examples')) lines.push('- examples: 3 example sentences using this word, with Korean translations');
    if (needs.includes('synonyms')) lines.push('- synonyms: 3–5 common synonyms');
  }
  return lines.join('\n');
}

const inflight = new Map<string, Promise<AiFill | null>>();

/** Cached AI fill for a word, or null if none is stored yet. Never calls Gemini. */
export async function cachedFill(key: string): Promise<AiFill | null> {
  return ((await db.aiEntries.get(key))?.entry as AiFill) ?? null;
}

/** The AI fill for a word: from cache, or one Gemini call if the dictionary falls short. */
export function getAiFill(key: string, entry: DictEntry | null, settings: Settings): Promise<AiFill | null> {
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const cached = await cachedFill(key);
      if (cached) return cached;
      const needs = aiNeeds(entry);
      if (!needs.length) return null;
      const conn = connFrom(settings);
      const model = settings.models?.lookup;
      if (!conn || !model) throw new AiUnavailable();
      const fill = await generateJSON<AiFill>(conn, {
        model,
        system: SYSTEM,
        prompt: fillPrompt(key, entry, needs),
        schema: FILL_SCHEMA,
      });
      const clean = sanitize(fill, entry !== null, needs);
      await db.aiEntries.put({ word: key, entry: clean, model, createdAt: Date.now() });
      return clean;
    })();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => {});
  }
  return p;
}

function sanitize(f: AiFill, inDict: boolean, needs: ReturnType<typeof aiNeeds>): AiFill {
  const strs = (a: unknown) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const wantAll = needs.includes('all');
  return {
    found: inDict || f.found === true,
    word: typeof f.word === 'string' ? f.word.trim() : undefined,
    ipa: wantAll && typeof f.ipa === 'string' && f.ipa.trim() ? f.ipa.trim() : undefined,
    meanings: wantAll || needs.includes('meanings')
      ? (f.meanings ?? []).filter((m) => m && m.g).slice(0, 4).map((m) => ({ p: m.p || '', g: m.g, ko: strs(m.ko).slice(0, 3) }))
      : [],
    examples: wantAll || needs.includes('examples')
      ? (f.examples ?? []).filter((x) => x?.en && x?.ko).slice(0, 3)
      : [],
    synonyms: wantAll || needs.includes('synonyms') ? strs(f.synonyms).slice(0, 5) : [],
  };
}

// ---------------------------------------------------------------- 쉬운 설명

const NOTE_SCHEMA = {
  type: 'OBJECT',
  properties: { note: { ...STR, description: '1–2 sentences in plain Korean' } },
  required: ['note'],
};

const noteInflight = new Map<string, Promise<string>>();

/** Generates the 쉬운 설명 once per word (on first save) and caches it. */
export function ensureEasyNote(key: string, word: string, koMeanings: string[], gloss: string, settings: Settings): Promise<string> {
  let p = noteInflight.get(key);
  if (!p) {
    p = (async () => {
      const cached = await db.easyNotes.get(key);
      if (cached) return cached.text;
      const conn = connFrom(settings);
      const model = settings.models?.lookup;
      if (!conn || !model) throw new AiUnavailable();
      const { note } = await generateJSON<{ note: string }>(conn, {
        model,
        system:
          'You explain English words to Korean adults (including older learners) in plain, friendly Korean. ' +
          'Use 1–2 short sentences, no romanization, no lists, no greetings.',
        prompt:
          `단어: ${word}\n뜻: ${koMeanings.join(', ') || '(없음)'}\n영어 정의: ${gloss || '(없음)'}\n\n` +
          '이 단어의 뉘앙스와 실제로 언제·어떻게 쓰는지 쉬운 한국어로 1~2문장으로 설명해 주세요. ' +
          '비슷한 한국어 표현과 다른 점이 있으면 짧게 알려 주세요.',
        schema: NOTE_SCHEMA,
        temperature: 0.5,
      });
      const text = note.trim();
      await db.easyNotes.put({ word: key, text, model, createdAt: Date.now() });
      return text;
    })();
    noteInflight.set(key, p);
    p.finally(() => noteInflight.delete(key)).catch(() => {});
  }
  return p;
}
