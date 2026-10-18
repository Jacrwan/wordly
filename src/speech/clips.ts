import { GeminiError, type Conn } from '../ai/gemini';
import { RATE, synthesize, wavBlob } from '../ai/tts';
import { db, type ClipDetail, type WordClip } from '../db/schema';
import { splitAtPauses } from './split';

// Lock-screen word player: each saved word's segment (word → Korean → definition → synonyms)
// is voiced once by Gemini TTS and kept in IndexedDB. A listening session joins the cached
// clips into one WAV, because an <audio> file keeps playing on a locked iPhone while Web
// Speech stops (docs/ios-audio-findings.md). TTS models allow only ~20 requests a day on the
// free tier, so several words share one request and the audio is cut at the pauses between them.
// Neighbouring words in a request are read by the two podcast hosts in turn, which helps find
// where one word ends (split.ts) and keeps a long list from sounding monotonous.

// The podcast's two-speaker request shape (known to work with the Flash TTS models).
export const SPEAKERS = [{ speaker: 'Mina', voice: 'Kore' }, { speaker: 'Jake', voice: 'Puck' }];
const DETAIL: ClipDetail = 'full';
// Invalidate clips produced by the earlier, inaccurate length-only splitter.
const CLIP_VERSION = 2;
const BATCH_WORDS = 8;
const BATCH_CHARS = 900; // ≈ 60 s of speech per request
const LEAD_S = 0.4; // silence before the first word of a session
const GAP_S = 1.0; // silence between words

export interface ClipItem {
  key: string;
  word: string;
  ko: string[];
  definition: string;
  synonyms: string[];
}

/** What the TTS voice reads for one word. */
export function clipText(it: ClipItem): string {
  const lines = [`${it.word}.`];
  if (it.ko.length) lines.push(`${it.ko.join(', ')}.`);
  if (it.definition) lines.push(`${it.definition.replace(/[.…]+$/, '')}.`);
  if (it.synonyms.length) lines.push(`Similar words: ${it.synonyms.join(', ')}.`);
  return lines.join('\n');
}

/** Cached clips that still match each word's current text. */
export async function cachedClips(items: ClipItem[]): Promise<Map<string, WordClip>> {
  const rows = await db.wordClips.bulkGet(items.map((it) => [it.key, DETAIL] as [string, ClipDetail]));
  const out = new Map<string, WordClip>();
  rows.forEach((row, i) => {
    if (row && row.version === CLIP_VERSION && row.text === clipText(items[i]) && SPEAKERS.some((s) => s.voice === row.voice)) out.set(items[i].key, row);
  });
  return out;
}

export interface MakeProgress {
  done: number; // words voiced so far
  total: number;
  waitMs?: number; // every TTS model is briefly busy; retrying after this long
}

export type MakeResult = { made: number; stopped?: 'quota' | 'cancelled' | 'error'; error?: unknown };

/** Voices the given (uncached) words in batches and stores each word's clip. */
export async function makeClips(conn: Conn, models: string[], items: ClipItem[], onProgress: (p: MakeProgress) => void, cancel: AbortSignal): Promise<MakeResult> {
  let made = 0;
  for (const batch of batches(items)) {
    if (cancel.aborted) return { made, stopped: 'cancelled' };
    onProgress({ done: made, total: items.length });
    try {
      const texts = batch.map(clipText);
      const { pcm, model } = await synthesize(conn, models, hostsBody(texts, (i) => i % 2), { cancel, onWait: (waitMs) => onProgress({ done: made, total: items.length, waitMs }) });
      if (cancel.aborted) return { made, stopped: 'cancelled' };
      const voices = batch.map((_, i) => i % 2);
      const pieces = splitAtPauses(pcm, texts.map((t) => t.split('\n')), voices);
      const now = Date.now();
      await db.wordClips.bulkPut(batch.map((it, i) => ({
        word: it.key,
        version: CLIP_VERSION,
        detail: DETAIL,
        text: texts[i],
        voice: SPEAKERS[voices[i]].voice,
        pcm: new Blob([pieces[i].slice().buffer as ArrayBuffer], { type: 'audio/L16' }),
        seconds: pieces[i].length / RATE,
        model,
        createdAt: now,
      })));
      made += batch.length;
    } catch (e) {
      if (cancel.aborted) return { made, stopped: 'cancelled' };
      if (e instanceof GeminiError && e.kind === 'rate-limit') return { made, stopped: 'quota', error: e };
      return { made, stopped: 'error', error: e };
    }
  }
  onProgress({ done: made, total: items.length });
  return { made };
}

export function batches(items: ClipItem[]): ClipItem[][] {
  const out: ClipItem[][] = [];
  let cur: ClipItem[] = [];
  let size = 0;
  for (const it of items) {
    const n = clipText(it).length;
    if (cur.length && (cur.length >= BATCH_WORDS || size + n > BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A TTS request with one text part per item, each read by host `host(i)` (0 = Mina, 1 = Jake). */
export function hostsBody(texts: string[], host: (i: number) => number): object {
  return {
    contents: [{ role: 'user', parts: texts.map((text, i) => ({ text, speechMetadata: { speaker: SPEAKERS[host(i)].speaker } })) }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: SPEAKERS.map((s) => ({ speaker: s.speaker, voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } })),
        },
      },
    },
  };
}

// ---------------------------------------------------------------- sessions

export interface Session {
  audio: Blob; // one WAV for the whole list
  order: number[]; // item indexes that have audio, in play order
  starts: number[]; // seconds, per entry of `order`
  duration: number;
}

/** Joins the cached clips of a list into one WAV (clips are referenced, not copied). */
export function buildSession(items: ClipItem[], clips: Map<string, WordClip>): Session | null {
  const silence = (s: number) => new Int16Array(Math.round(s * RATE));
  const parts: (Int16Array | Blob)[] = [silence(LEAD_S)];
  const order: number[] = [];
  const starts: number[] = [];
  let t = LEAD_S;
  items.forEach((it, i) => {
    const clip = clips.get(it.key);
    if (!clip) return;
    if (order.length) {
      parts.push(silence(GAP_S));
      t += GAP_S;
    }
    order.push(i);
    starts.push(t);
    parts.push(clip.pcm);
    t += clip.pcm.size / 2 / RATE;
  });
  if (!order.length) return null;
  parts.push(silence(GAP_S));
  return { audio: wavBlob(parts), order, starts, duration: t + GAP_S };
}
