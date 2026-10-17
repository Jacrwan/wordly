import { dictShardId, koShardId, loadShard } from './store';
import { isPointer, type AiFill, type DictEntry, type RawEntry, type WordView } from './types';

const AUDIO_BASE = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/';
const HANGUL = /[가-힣]/;

export const isKorean = (q: string) => HANGUL.test(q);

/** Lowercase, single spaces, straight apostrophes: the form used as dictionary keys. */
export function normalize(q: string): string {
  return q.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
}

export type Found =
  | { kind: 'found'; key: string; entry: DictEntry; via?: string } // via: the inflected form typed ("went")
  | { kind: 'missing'; key: string }
  | { kind: 'offline'; key: string };

export async function findEntry(query: string): Promise<Found> {
  let key = normalize(query);
  let via: string | undefined;
  for (let hop = 0; hop < 3; hop++) {
    const shard = await loadShard<RawEntry>('dict', dictShardId(key));
    if (shard === null) return { kind: 'offline', key };
    const raw = shard[key];
    if (!raw) return { kind: 'missing', key };
    if (!isPointer(raw)) return { kind: 'found', key, entry: raw, via };
    via ??= raw.w;
    key = normalize(raw.to);
  }
  return { kind: 'missing', key };
}

export interface Suggestion {
  key: string;
  word: string;
  ko: string[];
}

/** Words starting with the query (from the query's own shard), most frequent first. */
export async function suggest(query: string, limit = 8): Promise<Suggestion[]> {
  const q = normalize(query);
  if (q.length < 2) return [];
  const shard = await loadShard<RawEntry>('dict', dictShardId(q));
  if (!shard) return [];
  return Object.entries(shard)
    .filter(([k, e]) => k.startsWith(q) && !isPointer(e))
    .sort(([ka, a], [kb, b]) => Number(kb === q) - Number(ka === q) || a.r - b.r)
    .slice(0, limit)
    .map(([key, e]) => ({ key, word: e.w, ko: koSummary(e as DictEntry) }));
}

/** Korean → English: exact term, then its 하다/되다 stem, then terms starting with it. */
export async function koSearch(query: string, limit = 20): Promise<Suggestion[] | null> {
  const q = query.trim().replace(/\s+/g, '');
  if (!q) return [];
  const index = await loadShard<string[]>('ko', koShardId(q));
  if (index === null) return null;
  const keys: string[] = [];
  const add = (list?: string[]) => list?.forEach((k) => !keys.includes(k) && keys.push(k));
  add(index[q]);
  for (const suffix of ['하다', '되다', '시키다']) if (q.endsWith(suffix)) add(index[q.slice(0, -suffix.length)]);
  if (keys.length < limit) {
    Object.keys(index)
      .filter((k) => k.startsWith(q) && k !== q)
      .sort((a, b) => a.length - b.length)
      .slice(0, 10)
      .forEach((k) => add(index[k]));
  }
  const results = await Promise.all(
    keys.slice(0, limit).map(async (key) => {
      const f = await findEntry(key);
      return f.kind === 'found' ? { key: f.key, word: f.entry.w, ko: koSummary(f.entry) } : null;
    }),
  );
  return results.filter((r): r is Suggestion => r !== null);
}

export function koSummary(e: DictEntry, n = 3): string[] {
  const all = [...(e.top ?? []), ...e.pos.flatMap((b) => b.s.flatMap((s) => s.ko ?? [])), ...(e.ko ?? []), ...(e.ofKo ?? [])];
  return [...new Set(all)].slice(0, n);
}

export function audioUrl(au?: string): string | undefined {
  if (!au) return undefined;
  if (au.startsWith('http')) return au;
  return `${AUDIO_BASE}${au}/${au.split('/').pop()}.mp3`;
}

/** Example pairs from either data format (reviewed `eg`, or `tt` in older files). */
const entryExamples = (e: DictEntry) =>
  e.eg?.map((x) => ({ en: x.e, ko: x.k, meaning: x.m, ai: x.a === 1 })) ?? (e.tt ?? []).map(([en, ko]) => ({ en, ko }));
const exampleCount = (e: DictEntry) => entryExamples(e).length;
const hasKorean = (e: DictEntry) => koSummary(e, 1).length > 0;

/** What Gemini must fill for this word (spec: missing word, no Korean, or < 2 Korean examples). */
export function aiNeeds(entry: DictEntry | null): ('all' | 'meanings' | 'examples' | 'synonyms')[] {
  if (!entry) return ['all'];
  const needs: ('meanings' | 'examples' | 'synonyms')[] = [];
  if (!hasKorean(entry)) needs.push('meanings');
  if (exampleCount(entry) < 2) needs.push('examples');
  // Synonyms alone never trigger a call, but ride along when we're calling anyway.
  if (needs.length && (entry.syn?.length ?? 0) < 3) needs.push('synonyms');
  return needs;
}

export function buildView(key: string, entry: DictEntry | null, ai: AiFill | null): WordView | null {
  if (!entry && !ai?.found) return null;
  const meanings: WordView['meanings'] = [];
  // Within each part of speech, senses whose Korean is a main meaning come first (in usage
  // order), then other senses with Korean, then the rest: apply → 지원하다 before 대다.
  const top = entry?.top ?? [];
  const senseRank = (s: { ko?: string[] }) => {
    const i = Math.min(...(s.ko ?? []).map((k) => top.indexOf(k)).filter((i) => i >= 0));
    return Number.isFinite(i) ? i : s.ko?.length ? top.length : top.length + 1;
  };
  for (const b of entry?.pos ?? []) {
    const senses = b.s.map((s, i) => ({ s, i })).sort((a, z) => senseRank(a.s) - senseRank(z.s) || a.i - z.i);
    for (const { s } of senses) meanings.push({ p: b.p, g: s.g, ko: s.ko ?? [], ex: s.ex });
  }
  // An AI fill cached before the dictionary improved is only used for what's still missing.
  const needs = entry ? aiNeeds(entry) : ['all'];
  const useAiMeanings = !entry || needs.includes('meanings');
  const useAiExamples = !entry || needs.includes('examples');
  // AI meanings go first when the dictionary has no Korean, so the Korean is visible at the top.
  const aiMeanings = useAiMeanings ? (ai?.meanings ?? []).map((m) => ({ ...m, ai: true })) : [];
  const ordered = entry && hasKorean(entry) ? [...meanings, ...aiMeanings] : [...aiMeanings, ...meanings];

  const syn = entry?.syn ?? [];
  const aiSyn = (ai?.synonyms ?? []).filter((s) => !syn.some((x) => x.toLowerCase() === s.toLowerCase()));
  const synonyms = [...syn, ...aiSyn].slice(0, 5);

  return {
    key,
    word: entry?.w ?? ai?.word ?? key,
    rank: entry?.r ?? null,
    ipa: entry?.ipa ?? ai?.ipa,
    ipaAi: !entry?.ipa && !!ai?.ipa,
    audioUrl: audioUrl(entry?.au),
    meanings: ordered,
    wordKo: entry?.ko ?? [],
    ofWord: entry?.of?.[0],
    ofKo: entry?.ofKo,
    synonyms,
    synonymsAi: synonyms.some((s) => aiSyn.includes(s)),
    examples: [
      ...(entry ? entryExamples(entry) : []),
      ...(useAiExamples ? ai?.examples ?? [] : []).map((x) => ({ ...x, ai: true })),
    ],
    topKo: top.length ? top : aiMeanings.flatMap((m) => m.ko).slice(0, 4),
    topKoAi: top.length ? entry?.topAi ?? [] : aiMeanings.flatMap((m) => m.ko),
    fromAiOnly: !entry,
  };
}

/** Korean meanings for lists and saved-word snapshots, most common first. */
export function viewKo(v: WordView, n = 3): string[] {
  const all = [...v.topKo, ...v.meanings.flatMap((m) => m.ko), ...v.wordKo, ...(v.ofKo ?? [])];
  return [...new Set(all)].slice(0, n);
}
