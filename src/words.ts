import { createEmptyCard } from 'ts-fsrs';
import { viewKo } from './dict/lookup';
import type { WordView } from './dict/types';
import { db, type CardDir, type MyWord, type WordStatus } from './db/schema';

const DIRS: CardDir[] = ['en2ko', 'ko2en'];

/** Adds a word to My Words with a recognition (en→ko) and a recall (ko→en) FSRS card. */
export async function saveWord(view: WordView, source: string): Promise<'added' | 'exists'> {
  return db.transaction('rw', db.myWords, db.cards, async () => {
    const existing = await db.myWords.get(view.key);
    if (existing) {
      if (existing.status === 'archived') await db.myWords.update(view.key, { status: 'learning' });
      return 'exists';
    }
    const now = new Date();
    const row: MyWord = {
      word: view.key,
      display: view.word,
      ko: viewKo(view),
      rank: view.rank,
      status: 'learning',
      addedAt: now.getTime(),
      source,
    };
    await db.myWords.put(row);
    for (const dir of DIRS) {
      const card = createEmptyCard(now);
      await db.cards.put({ word: view.key, dir, due: card.due, card });
    }
    return 'added';
  });
}

export async function setStatus(key: string, status: WordStatus): Promise<void> {
  await db.myWords.update(key, { status });
}

/** Removes a word and its review history. Cached dictionary/AI data stays. */
export async function removeWord(key: string): Promise<void> {
  await db.transaction('rw', db.myWords, db.cards, db.reviewLogs, async () => {
    await db.myWords.delete(key);
    await db.cards.where('word').equals(key).delete();
    await db.reviewLogs.where('word').equals(key).delete();
  });
}
