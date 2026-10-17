import { fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs';
import { db, type CardDir, type CardRow, type UiLang } from './db/schema';

// Spaced repetition. Every saved word has two FSRS cards: en2ko (see English, recall Korean)
// and ko2en (see Korean, recall English). Only active recall changes them: reviews here,
// and correct use in conversation (step 7). Listening never does.

export { Rating };
export type { Grade };

const scheduler = fsrs({ enable_fuzz: true });

/** A word counts as mastered when both cards are in review with an interval of 3+ weeks. */
export const MASTERED_DAYS = 21;
/** When nothing else is due, cards in short-term learning (due within this window) are shown early. */
const LEARN_AHEAD_MS = 20 * 60 * 1000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const asCard = (row: CardRow) => row.card as Card;

async function activeCards(): Promise<CardRow[]> {
  const words = await db.myWords.where('status').notEqual('archived').primaryKeys();
  const active = new Set(words as string[]);
  return (await db.cards.toArray()).filter((c) => active.has(c.word));
}

async function newCardsLeftToday(dailyNewWords: number): Promise<number> {
  const introduced = await db.reviewLogs.where('ts').aboveOrEqual(startOfToday()).filter((l) => !!l.wasNew).count();
  return Math.max(0, dailyNewWords * 2 - introduced); // two cards per word
}

export interface QueueStats {
  due: number; // review/relearning cards due now
  fresh: number; // new cards that can still be introduced today
  learning: number; // cards in short-term learning, due within minutes
  nextDue: Date | null; // when the next card becomes due (if nothing is due now)
}

export async function queueStats(dailyNewWords: number): Promise<QueueStats> {
  const now = Date.now();
  const cards = await activeCards();
  const notNew = cards.filter((c) => asCard(c).state !== State.New);
  const newCount = cards.length - notNew.length;
  const future = notNew.filter((c) => c.due.getTime() > now).map((c) => c.due.getTime());
  return {
    due: notNew.filter((c) => c.due.getTime() <= now).length,
    fresh: Math.min(newCount, await newCardsLeftToday(dailyNewWords)),
    learning: notNew.filter((c) => c.due.getTime() > now && c.due.getTime() <= now + LEARN_AHEAD_MS).length,
    nextDue: future.length ? new Date(Math.min(...future)) : null,
  };
}

/**
 * The next card to show: due reviews first (oldest first), then new cards within today's
 * limit (recognition before recall, oldest saved first), then learning cards a few minutes
 * early. Avoids showing the same word twice in a row when there's another choice.
 */
export async function nextCard(dailyNewWords: number, lastWord?: string, ahead = false): Promise<CardRow | null> {
  const now = Date.now();
  const cards = await activeCards();
  const pick = (list: CardRow[]) => list.find((c) => c.word !== lastWord) ?? list[0] ?? null;

  const due = cards
    .filter((c) => asCard(c).state !== State.New && c.due.getTime() <= now)
    .sort((a, b) => a.due.getTime() - b.due.getTime());
  if (due.length) return pick(due);

  if ((await newCardsLeftToday(dailyNewWords)) > 0) {
    const added = new Map((await db.myWords.toArray()).map((w) => [w.word, w.addedAt]));
    const fresh = cards
      .filter((c) => asCard(c).state === State.New)
      .sort((a, b) => (a.dir === b.dir ? 0 : a.dir === 'en2ko' ? -1 : 1) || (added.get(a.word) ?? 0) - (added.get(b.word) ?? 0));
    if (fresh.length) return pick(fresh);
  }

  const window = ahead ? Infinity : LEARN_AHEAD_MS;
  const soon = cards
    .filter((c) => asCard(c).state !== State.New && c.due.getTime() <= now + window)
    .sort((a, b) => a.due.getTime() - b.due.getTime());
  return pick(soon);
}

/** Interval label for each rating button, e.g. { 1: "1분", 3: "3일" }. */
export function preview(row: CardRow, lang: UiLang): Record<Grade, string> {
  const now = new Date();
  const out = {} as Record<Grade, string>;
  for (const item of scheduler.repeat(asCard(row), now)) {
    out[item.log.rating as Grade] = formatInterval(item.card.due.getTime() - now.getTime(), lang);
  }
  return out;
}

export function formatInterval(ms: number, lang: UiLang): string {
  const min = Math.max(1, Math.round(ms / 60000));
  const units = lang === 'ko'
    ? { m: '분', h: '시간', d: '일', mo: '개월', y: '년' }
    : { m: 'm', h: 'h', d: 'd', mo: 'mo', y: 'y' };
  if (min < 60) return `${min}${units.m}`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}${units.h}`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d}${units.d}`;
  if (d < 365) return `${Math.round(d / 30)}${units.mo}`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}${units.y}`;
}

/** Records an answer, reschedules the card, and updates the word's mastery. */
export async function rate(word: string, dir: CardDir, grade: Grade, source: 'review' | 'conversation' = 'review'): Promise<void> {
  await db.transaction('rw', db.cards, db.reviewLogs, db.myWords, async () => {
    const row = await db.cards.get([word, dir]);
    if (!row) return;
    const now = new Date();
    const { card } = scheduler.next(asCard(row), now, grade);
    await db.cards.put({ ...row, due: card.due, card });
    await db.reviewLogs.add({ word, dir, rating: grade, source, ts: now.getTime(), wasNew: asCard(row).state === State.New });
    await updateMastery(word, grade);
  });
}

async function updateMastery(word: string, grade: Grade): Promise<void> {
  const w = await db.myWords.get(word);
  if (!w || w.status === 'archived') return;
  const cards = (await db.cards.where('word').equals(word).toArray()).map(asCard);
  const mastered = cards.length === 2 && cards.every((c) => c.state === State.Review && c.scheduled_days >= MASTERED_DAYS);
  // Forgetting a mastered word (Again) sends it back to learning; it still returns on schedule either way.
  const status = mastered && grade !== Rating.Again ? 'mastered' : 'learning';
  if (status !== w.status) await db.myWords.update(word, { status });
}
