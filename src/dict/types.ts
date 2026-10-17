// Shapes of the files written by scripts/build_dict.py (see docs/PLAN.md, step 2).

export interface Sense {
  g: string; // English gloss
  ko?: string[];
  ex?: string[]; // English-only Wiktionary examples
}

export interface PosBlock {
  p: string; // part of speech: noun, verb, adj, adv, phrase, …
  s: Sense[];
}

export interface DictEntry {
  w: string; // display spelling
  r: number; // frequency rank
  ipa?: string;
  au?: string; // Commons audio path or full URL
  pos: PosBlock[];
  ko?: string[]; // word-level Korean not tied to a sense
  syn?: string[];
  ant?: string[];
  top?: string[]; // Korean meanings, most used first (OpenSubtitles counts / Gemini review)
  topAi?: string[]; // meanings in `top` that Gemini added (not in the dictionary)
  eg?: { e: string; k: string; m?: string; a?: 1 }[]; // reviewed examples: English, Korean, meaning shown, AI-written
  of?: string[]; // base word(s) for inflected forms with their own senses
  ofKo?: string[]; // Korean borrowed from of[0]
}

export interface Pointer {
  w: string;
  to: string; // lemma
  r: number;
}

export type RawEntry = DictEntry | Pointer;

export const isPointer = (e: RawEntry): e is Pointer => 'to' in e;

export interface Manifest {
  version: string;
  audioBase: string;
  dict: string[];
  ko: string[];
  bytes: number;
  gzipBytes: number;
}

export interface Shard<T> {
  v: string;
  e: Record<string, T>;
}

// What Gemini adds when the dictionary falls short. Stored once per word in aiEntries.
export interface AiFill {
  found: boolean; // false: Gemini says this isn't an English word
  word?: string; // corrected / canonical spelling
  ipa?: string;
  meanings?: { p: string; g: string; ko: string[] }[];
  examples?: { en: string; ko: string }[];
  synonyms?: string[];
}

/** A dictionary entry merged with its AI fill, ready for the word card. */
export interface WordView {
  key: string;
  word: string;
  rank: number | null;
  ipa?: string;
  audioUrl?: string;
  meanings: { p: string; g: string; ko: string[]; ex?: string[]; ai?: boolean }[];
  wordKo: string[]; // Korean not tied to a sense
  ofWord?: string; // "years" → "year"
  ofKo?: string[];
  synonyms: string[];
  synonymsAi: boolean;
  examples: { en: string; ko: string; meaning?: string; ai?: boolean }[];
  topKo: string[]; // main Korean meanings, most common first
  topKoAi: string[]; // items of topKo that AI added
  ipaAi: boolean;
  fromAiOnly: boolean; // the word isn't in the bundled dictionary
}
