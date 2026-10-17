import { GeminiError, type Conn } from '../ai/gemini';
import { RATE, synthesize, wavBlob } from '../ai/tts';
import { db, type ClipDetail, type WordClip } from '../db/schema';

// Lock-screen word player: each saved word's segment (word → Korean → definition → synonyms)
// is voiced once by Gemini TTS and kept in IndexedDB. A listening session joins the cached
// clips into one WAV, because an <audio> file keeps playing on a locked iPhone while Web
// Speech stops (docs/ios-audio-findings.md). TTS models allow only ~20 requests a day on the
// free tier, so several words share one request and the audio is cut at the pauses between them.

export const VOICE = 'Kore';
const DETAIL: ClipDetail = 'full';
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
    if (row && row.text === clipText(items[i]) && row.voice === VOICE) out.set(items[i].key, row);
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
    onProgress({ done: made, total: items.length });
    try {
      const texts = batch.map(clipText);
      const { pcm, model } = await synthesize(conn, models, ttsBody(texts), { cancel, onWait: (waitMs) => onProgress({ done: made, total: items.length, waitMs }) });
      const pieces = splitAtPauses(pcm, texts.map(spokenLength));
      const now = Date.now();
      await db.wordClips.bulkPut(batch.map((it, i) => ({
        word: it.key,
        detail: DETAIL,
        text: texts[i],
        voice: VOICE,
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

function batches(items: ClipItem[]): ClipItem[][] {
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

// The podcast's two-speaker request shape (known to work with the Flash TTS models), with every
// word read by the same host; each word is its own part, so the voice pauses between them.
const SPEAKER = 'Mina';
const SPEAKERS = [{ speaker: SPEAKER, voice: VOICE }, { speaker: 'Jake', voice: 'Puck' }];

function ttsBody(texts: string[]): object {
  return {
    contents: [{ role: 'user', parts: texts.map((text) => ({ text, speechMetadata: { speaker: SPEAKER } })) }],
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

/** Rough speaking time of a text: a Korean syllable takes about as long as two Latin letters. */
function spokenLength(text: string): number {
  let n = 0;
  for (const ch of text) n += /[가-힣]/.test(ch) ? 2 : /[\p{L}\p{N}]/u.test(ch) ? 1 : ch === '\n' ? 6 : 0.5;
  return n;
}

// ---------------------------------------------------------------- cutting a batch into words

const FRAME = RATE / 50; // 20 ms
const MIN_PAUSE_FRAMES = 8; // 160 ms
const EDGE_PAD = Math.round(RATE * 0.08);

/**
 * Cuts one batch's audio into one piece per word. Cut points are first estimated from text
 * length (as podcast.ts does for lines), then moved to the longest pause nearby, which is
 * almost always the gap between two words. Each piece is trimmed of leading/trailing silence.
 */
export function splitAtPauses(pcm: Int16Array, lengths: number[]): Int16Array[] {
  const frames = Math.floor(pcm.length / FRAME);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(sum / FRAME);
  }
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(frames * 0.9)] ?? 0;
  const threshold = Math.max(120, loud * 0.06);
  const quiet = (f: number) => rms[f] < threshold;

  // Pauses: runs of quiet frames inside the voiced span.
  let first = 0;
  while (first < frames && quiet(first)) first++;
  let last = frames - 1;
  while (last > first && quiet(last)) last--;
  const pauses: { mid: number; len: number }[] = [];
  for (let f = first; f <= last; f++) {
    if (!quiet(f)) continue;
    const start = f;
    while (f <= last && quiet(f)) f++;
    if (f - start >= MIN_PAUSE_FRAMES) pauses.push({ mid: (start + f) / 2, len: f - start });
  }

  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const span = last - first + 1;
  const window = (span / lengths.length) * 0.5;
  const cuts: number[] = [];
  let acc = 0;
  let prev = first;
  for (let k = 0; k < lengths.length - 1; k++) {
    acc += lengths[k];
    const expected = first + (span * acc) / total;
    let best: { mid: number; score: number } | null = null;
    for (const p of pauses) {
      const dist = Math.abs(p.mid - expected);
      if (p.mid <= prev || dist > window) continue;
      const score = p.len / (1 + (2 * dist) / window);
      if (!best || score > best.score) best = { mid: p.mid, score };
    }
    const cut = Math.max(prev + 1, Math.round(best?.mid ?? expected));
    cuts.push(cut);
    prev = cut;
  }

  const bounds = [0, ...cuts.map((c) => c * FRAME), pcm.length];
  return lengths.map((_, i) => trim(pcm.subarray(bounds[i], bounds[i + 1]), threshold));
}

function trim(pcm: Int16Array, threshold: number): Int16Array {
  const loud = (f: number) => {
    let sum = 0;
    for (let i = f * FRAME; i < Math.min(pcm.length, (f + 1) * FRAME); i++) sum += pcm[i] * pcm[i];
    return Math.sqrt(sum / FRAME) >= threshold;
  };
  const frames = Math.ceil(pcm.length / FRAME);
  let a = 0;
  while (a < frames && !loud(a)) a++;
  let b = frames - 1;
  while (b > a && !loud(b)) b--;
  if (a >= frames) return pcm;
  return pcm.subarray(Math.max(0, a * FRAME - EDGE_PAD), Math.min(pcm.length, (b + 1) * FRAME + EDGE_PAD));
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
