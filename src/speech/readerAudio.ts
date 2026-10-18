import { GeminiError, type Conn } from '../ai/gemini';
import { RATE, synthesize, wavBlob } from '../ai/tts';
import { db, type ReaderClip } from '../db/schema';
import type { Timeline } from '../hooks/useAudioTimeline';
import { hostsBody, SPEAKERS } from './clips';
import { splitAtPauses } from './split';

// Text reader audio: the text is voiced by Gemini TTS in runs of sentences (one request each),
// cached in IndexedDB by content, and played as one audio file so reading continues with the
// screen locked or the app in the background. Each run's audio is cut at the pauses between
// its sentences (split.ts) to know where every sentence starts, for highlighting and seeking.

const VERSION = 1;
const HOST = 0; // Mina reads everything
const CHUNK_CHARS = 1000; // ≈ 70 s of speech per request
const KEEP = 60; // cached runs kept; older ones are dropped
const LEAD_S = 0.3;
const SENTENCE_GAP_S = 0.5; // silence after every sentence

export interface Run {
  sentences: number[]; // indexes into the text's sentences
  key: string;
}

/** Groups sentences into runs of up to CHUNK_CHARS and gives each a content key. */
export async function readerRuns(sentences: string[]): Promise<Run[]> {
  const groups: number[][] = [];
  let cur: number[] = [];
  let size = 0;
  sentences.forEach((s, i) => {
    if (cur.length && size + s.length > CHUNK_CHARS) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += s.length;
  });
  if (cur.length) groups.push(cur);
  return Promise.all(groups.map(async (g) => ({ sentences: g, key: await hash([VERSION, SPEAKERS[HOST].voice, ...g.map((i) => sentences[i])].join('\n')) })));
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cachedRuns(runs: Run[]): Promise<Map<string, ReaderClip>> {
  const rows = await db.readerClips.bulkGet(runs.map((r) => r.key));
  return new Map(rows.filter((r): r is ReaderClip => !!r).map((r) => [r.key, r]));
}

export interface MakeProgress {
  done: number; // runs voiced so far
  total: number;
  waitMs?: number;
}

export type MakeResult = { made: number; stopped?: 'quota' | 'cancelled' | 'error'; error?: unknown };

/** Voices the given (uncached) runs one request each and stores them. */
export async function makeRuns(conn: Conn, models: string[], sentences: string[], runs: Run[], onProgress: (p: MakeProgress) => void, cancel: AbortSignal): Promise<MakeResult> {
  let made = 0;
  for (const run of runs) {
    if (cancel.aborted) return { made, stopped: 'cancelled' };
    onProgress({ done: made, total: runs.length });
    try {
      const texts = run.sentences.map((i) => sentences[i]);
      const { pcm, model } = await synthesize(conn, models, hostsBody(texts, () => HOST), { cancel, onWait: (waitMs) => onProgress({ done: made, total: runs.length, waitMs }) });
      if (cancel.aborted) return { made, stopped: 'cancelled' };
      const { starts, ends } = sentenceTimes(pcm, texts);
      await db.readerClips.put({ key: run.key, pcm: new Blob([pcm.slice().buffer as ArrayBuffer], { type: 'audio/L16' }), starts, ends, model, createdAt: Date.now() });
      made++;
    } catch (e) {
      if (cancel.aborted) return { made, stopped: 'cancelled' };
      if (e instanceof GeminiError && e.kind === 'rate-limit') return { made, stopped: 'quota', error: e };
      return { made, stopped: 'error', error: e };
    }
  }
  await prune();
  onProgress({ done: made, total: runs.length });
  return { made };
}

/** Where each sentence starts and ends in a run's audio. */
function sentenceTimes(pcm: Int16Array, texts: string[]): { starts: number[]; ends: number[] } {
  try {
    const pieces = splitAtPauses(pcm, texts.map((t) => [t]));
    return {
      starts: pieces.map((p) => p.byteOffset / 2 / RATE),
      ends: pieces.map((p) => (p.byteOffset / 2 + p.length) / RATE),
    };
  } catch {
    // No clear pauses: share the run's length out by text length (highlighting is then approximate).
    const total = texts.reduce((n, t) => n + t.length, 0) || 1;
    const secs = pcm.length / RATE;
    const starts: number[] = [];
    const ends: number[] = [];
    let t = 0;
    for (const text of texts) {
      starts.push(t);
      t += (secs * text.length) / total;
      ends.push(t);
    }
    return { starts, ends };
  }
}

async function prune(): Promise<void> {
  const n = await db.readerClips.count();
  if (n > KEEP) await db.readerClips.orderBy('createdAt').limit(n - KEEP).delete();
}

export interface ReaderSession extends Timeline {
  order: number[]; // sentence indexes that have audio, in play order
}

/**
 * Joins the cached runs into one WAV, with each sentence's start and end in it. Every sentence is
 * followed by the same short silence (instead of the voice's own, sometimes very short pause), so
 * stopping or looping at a sentence's end never clips the start of the next one.
 */
export function buildReaderSession(runs: Run[], clips: Map<string, ReaderClip>): ReaderSession | null {
  const silence = (s: number) => new Int16Array(Math.round(s * RATE));
  const byte = (secs: number, size: number) => Math.min(size, Math.max(0, Math.round(secs * RATE) * 2));
  const parts: (Int16Array | Blob)[] = [silence(LEAD_S)];
  const order: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let t = LEAD_S;
  for (const run of runs) {
    const clip = clips.get(run.key);
    if (!clip) continue;
    const size = clip.pcm.size;
    run.sentences.forEach((s, i) => {
      const last = i === run.sentences.length - 1;
      // Timing shared out by length (no pauses found) leaves no gap between sentences: keep those
      // pieces back to back so nothing is cut out of the middle of speech.
      const touching = !last && clip.ends[i] >= clip.starts[i + 1] - 0.01;
      const from = byte(clip.starts[i], size);
      const to = touching ? byte(clip.starts[i + 1], size) : last ? size : byte(clip.ends[i], size);
      order.push(s);
      starts.push(t);
      // The last sentence keeps the run's trailing silence; its end is where the voice stops.
      ends.push(last ? t + clip.ends[i] - clip.starts[i] : t + (to - from) / 2 / RATE);
      parts.push(clip.pcm.slice(from, to));
      t += (to - from) / 2 / RATE;
      if (!touching) {
        parts.push(silence(SENTENCE_GAP_S));
        t += SENTENCE_GAP_S;
      }
    });
  }
  if (!order.length) return null;
  return { audio: wavBlob(parts), order, starts, ends };
}
