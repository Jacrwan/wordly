import { cachedFill, getAiFill } from '../ai/dictionary';
import { connFrom, generateJSON, lookupModels } from '../ai/gemini';
import { buildView, findEntry, koSummary, normalize } from '../dict/lookup';
import { db, type Level, type Pack, type Settings } from '../db/schema';
import { saveWord } from '../words';
import type { PackWord } from './fixed';

/** Difficulty from frequency rank (spec): Beginner ≤ 3,000, Intermediate ≤ 10,000, Advanced above. */
export function levelOf(rank: number | null | undefined): Level | null {
  if (rank == null) return null;
  return rank <= 3000 ? 'beginner' : rank <= 10000 ? 'intermediate' : 'advanced';
}

export interface PackRow extends PackWord {
  key: string;
  display: string;
  ko: string[];
  level: Level | null;
  inDict: boolean;
  saved: boolean;
}

/** Looks up each pack word in the local dictionary (no AI) and marks saved ones. */
export async function resolveRows(words: PackWord[]): Promise<PackRow[]> {
  const saved = new Set((await db.myWords.toCollection().primaryKeys()) as string[]);
  return Promise.all(
    words.map(async (pw) => {
      const found = await findEntry(pw.w);
      const entry = found.kind === 'found' ? found.entry : null;
      const fill = entry ? null : await cachedFill(found.key);
      return {
        ...pw,
        key: found.key,
        display: entry?.w ?? fill?.word ?? pw.w,
        ko: entry ? koSummary(entry, 3) : (fill?.meanings ?? []).flatMap((m) => m.ko).slice(0, 3),
        level: levelOf(entry?.r),
        inDict: !!entry,
        saved: saved.has(found.key),
      };
    }),
  );
}

/** Saves one pack word; words missing from the dictionary are filled by AI first (once, cached). */
export async function addFromPack(key: string, settings: Settings): Promise<'added' | 'exists' | 'unavailable'> {
  const found = await findEntry(key);
  const entry = found.kind === 'found' ? found.entry : null;
  let view = buildView(found.key, entry, await cachedFill(found.key));
  if (!view) {
    const fill = await getAiFill(found.key, null, settings);
    view = buildView(found.key, null, fill);
  }
  if (!view) return 'unavailable';
  return saveWord(view, 'pack');
}

// ---------------------------------------------------------------- AI packs from the profile

const LEVEL_HINT: Record<Level, string> = {
  beginner: 'beginner: very common everyday words (roughly the 3,000 most frequent English words)',
  intermediate: 'intermediate: useful words beyond the basics (roughly ranks 3,000–10,000 by frequency)',
  advanced: 'advanced: less common, more precise or formal words (beyond the 10,000 most frequent)',
};

const PACK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    packs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'short Korean title' },
          description: { type: 'STRING', description: 'one short Korean sentence' },
          words: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                w: { type: 'STRING', description: 'English word or short phrase, lowercase unless a proper noun' },
                why: { type: 'STRING', description: 'very short Korean reason it is useful for this person' },
              },
              required: ['w', 'why'],
              propertyOrdering: ['w', 'why'],
            },
          },
        },
        required: ['title', 'description', 'words'],
        propertyOrdering: ['title', 'description', 'words'],
      },
    },
  },
  required: ['packs'],
};

export function profileHash(s: Settings): string {
  const p = s.profile;
  return [p.ageRange, p.occupation.trim().toLowerCase(), p.level, [...p.goals].sort().join('+')].join('|');
}

export async function aiPacks(): Promise<Pack[]> {
  return (await db.packs.orderBy('createdAt').reverse().toArray()).filter((p) => p.generatedFrom);
}

/** Asks Gemini for 2 packs of ~20 words that fit the profile, then keeps words at the learner's level. */
export async function generatePacks(settings: Settings): Promise<Pack[]> {
  const conn = connFrom(settings);
  const models = lookupModels(settings.models);
  if (!conn || !models.length) throw new Error('unavailable');
  const p = settings.profile;
  const saved = ((await db.myWords.toCollection().primaryKeys()) as string[]).slice(0, 150);
  const { data } = await generateJSON<{ packs: { title: string; description: string; words: { w: string; why: string }[] }[] }>(conn, {
    models,
    system:
      'You design English vocabulary lists for Korean adults. Choose words this specific person will actually ' +
      'need in their daily life and goals. Prefer single words and common collocations; no proper nouns.',
    prompt: [
      `Age range: ${p.ageRange || 'unknown'}`,
      `Occupation: ${p.occupation || 'unknown'}`,
      `Goals: ${p.goals.join(', ') || 'general'}`,
      `English level: ${LEVEL_HINT[p.level]}`,
      saved.length ? `Already learning (do not repeat): ${saved.join(', ')}` : '',
      '',
      // Words outside the level are dropped afterwards, so ask for more than we show.
      'Create 2 themed packs of 30 words each for this person, at their level. Titles and descriptions in Korean.',
    ].join('\n'),
    schema: PACK_SCHEMA,
    temperature: 0.7,
    thinkingLevel: 'low',
  });

  const hash = profileHash(settings);
  const now = Date.now();
  const out: Pack[] = [];
  for (const [i, pk] of (data.packs ?? []).slice(0, 3).entries()) {
    const words: string[] = [];
    const notes: Record<string, string> = {};
    for (const x of pk.words ?? []) {
      const w = normalize(x.w ?? '');
      if (!w || words.includes(w) || saved.includes(w)) continue;
      const found = await findEntry(w);
      // Keep words at the learner's level; words not in the dictionary are kept (AI fills them on open).
      if (found.kind === 'found' && levelOf(found.entry.r) !== p.level) continue;
      words.push(w);
      if (x.why) notes[w] = x.why;
    }
    if (words.length) {
      out.push({
        id: `ai-${now}-${i}`, title: pk.title, description: pk.description, level: p.level,
        words, notes, generatedFrom: hash, createdAt: now + i,
      });
    }
  }
  await db.transaction('rw', db.packs, async () => {
    // A new set replaces the previous AI packs.
    await db.packs.filter((x) => !!x.generatedFrom).delete();
    await db.packs.bulkPut(out);
  });
  return out;
}
