import Dexie, { type Table } from 'dexie';

export type UiLang = 'ko' | 'en';
export type Level = 'beginner' | 'intermediate' | 'advanced';
export type WordStatus = 'learning' | 'mastered' | 'archived';
export type CardDir = 'en2ko' | 'ko2en';

export interface ModelChoice {
  lookup: string | null; // fast model: lookups, 쉬운 설명, packs
  long: string | null; // stronger model: conversation, podcast scripts
  tts: string | null; // multi-speaker TTS
  available: string[]; // every generateContent-capable model the key can see
  checkedAt: number;
}

export interface Profile {
  ageRange: string;
  occupation: string;
  level: Level;
  goals: string[];
}

export interface Settings {
  id: 'app';
  uiLang: UiLang;
  familyCode: string; // unlocks the shared Gemini proxy
  apiKey: string; // optional personal key; used instead of the proxy when set
  models: ModelChoice | null;
  profile: Profile;
  dailyNewCards: number;
  speech: { enVoice: string | null; koVoice: string | null; rate: number };
}

export interface DictShard {
  shardId: string;
  version: string;
  data: unknown;
}

export interface AiEntry {
  word: string;
  entry: unknown; // same shape as a dictionary entry (defined in step 2)
  model: string;
  createdAt: number;
}

export interface EasyNote {
  word: string;
  text: string;
  model: string;
  createdAt: number;
}

export interface MyWord {
  word: string; // dictionary key (lowercase)
  display: string; // spelling to show
  ko: string[]; // Korean meanings snapshot for lists
  rank: number | null;
  status: WordStatus;
  addedAt: number;
  source: string;
}

export interface CardRow {
  word: string;
  dir: CardDir;
  due: Date;
  card: unknown; // ts-fsrs Card (step 4)
}

export interface ReviewLogRow {
  id?: number;
  word: string;
  dir: CardDir;
  rating: number;
  source: 'review' | 'conversation';
  ts: number;
  wasNew?: boolean; // first time this card was seen (counts toward the daily new-word limit)
}

export interface Pack {
  id: string;
  title: string;
  description?: string;
  level: Level | null;
  words: string[];
  notes?: Record<string, string>; // per-word reason (AI packs)
  generatedFrom: string | null; // profile hash for AI packs, null for fixed packs
  createdAt: number;
}

export interface Chat {
  id?: number;
  scenario: string;
  messages: { role: 'user' | 'model'; text: string; meta?: unknown }[];
  wordsUsed: string[];
  startedAt: number;
}

export interface Podcast {
  id?: number;
  title: string;
  level: Level;
  words: string[];
  script: unknown;
  audio: Blob | null;
  audioSource: 'gemini' | 'webspeech';
  createdAt: number;
}

/** One saved word read aloud by Gemini TTS, for the lock-screen player (see speech/clips.ts). */
export interface WordClip {
  version?: number; // absent on old, incorrectly split clips
  word: string; // myWords key
  detail: ClipDetail;
  text: string; // what was read; a different text (e.g. a refreshed definition) means a new clip
  voice: string;
  pcm: Blob; // raw 16-bit 24 kHz mono samples
  span?: [number, number]; // bytes of pcm without static at the edges (see speech/edges.ts); set once
  seconds: number;
  model: string;
  createdAt: number;
}
export type ClipDetail = 'full';

/** A run of the text reader's sentences read aloud by Gemini TTS (see speech/readerAudio.ts). */
export interface ReaderClip {
  key: string; // hash of version, voice and the sentences
  pcm: Blob; // raw 16-bit 24 kHz mono samples
  span?: [number, number]; // bytes of pcm without static at the edges (see speech/edges.ts); set once
  starts: number[]; // seconds into pcm, one per sentence
  ends: number[];
  model: string;
  createdAt: number;
} // word → Korean → definition → synonyms

class WordlyDB extends Dexie {
  settings!: Table<Settings, string>;
  dictShards!: Table<DictShard, string>;
  aiEntries!: Table<AiEntry, string>;
  easyNotes!: Table<EasyNote, string>;
  myWords!: Table<MyWord, string>;
  cards!: Table<CardRow, [string, CardDir]>;
  reviewLogs!: Table<ReviewLogRow, number>;
  packs!: Table<Pack, string>;
  chats!: Table<Chat, number>;
  podcasts!: Table<Podcast, number>;
  wordClips!: Table<WordClip, [string, ClipDetail]>;
  readerClips!: Table<ReaderClip, string>;

  constructor() {
    super('wordly');
    this.version(1).stores({
      settings: 'id',
      dictShards: 'shardId',
      aiEntries: 'word',
      easyNotes: 'word',
      myWords: 'word, status, addedAt',
      cards: '[word+dir], word, due',
      reviewLogs: '++id, word, ts',
      packs: 'id, createdAt',
      chats: '++id, startedAt',
      podcasts: '++id, createdAt',
    });
    this.version(2).stores({ wordClips: '[word+detail], word' });
    this.version(3).stores({ readerClips: 'key, createdAt' });
  }
}

export const db = new WordlyDB();

export const defaultSettings: Settings = {
  id: 'app',
  uiLang: 'ko',
  familyCode: '',
  apiKey: '',
  models: null,
  profile: { ageRange: '', occupation: '', level: 'intermediate', goals: [] },
  dailyNewCards: 10,
  speech: { enVoice: null, koVoice: null, rate: 1 },
};

export async function loadSettings(): Promise<Settings> {
  const s = await db.settings.get('app');
  return { ...defaultSettings, ...s, profile: { ...defaultSettings.profile, ...s?.profile } };
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.settings.put(s);
}
