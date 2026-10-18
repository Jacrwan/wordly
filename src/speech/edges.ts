import { RATE } from '../ai/tts';

// Every Gemini TTS response ends with a ~150 ms burst at nearly full volume after the speech has
// gone silent (measured on real responses: RMS 12,000–20,000, rising until the audio stops). It
// is loud, so silence trimming kept it, and it was heard as a harsh "chzz" at the end of a word
// list or text before it looped, and at every chunk join inside a podcast. Two kinds of noise are
// removed at the edges of a response:
// - the burst: a short loud stretch after a pause that runs right up to the end of the audio
//   (speech always fades out before a response ends);
// - static with no voicing (judged by zero-crossing rate: vowels cross zero rarely, hiss
//   constantly), including a long voiceless tail stuck to the last word.

const FRAME = RATE / 50; // 20 ms
const PAUSE_FRAMES = 5; // 100 ms of quiet separates two stretches of sound
const MAX_ZCR_VOICED = 0.22;
const MIN_VOICED_FRAMES = 3; // a stretch with fewer voiced frames than this is not speech
const MAX_UNVOICED_TAIL = 15; // 300 ms: longer than any final "s"/"sh" the voice makes
const KEEP_TAIL = 4; // 80 ms of a final fricative is kept
const BURST_FRAMES = 20; // 400 ms: the burst is ~150 ms
const BURST_RMS = 8000;
const PAD = Math.round(RATE * 0.08);

interface Frame {
  rms: number;
  loud: boolean;
  voiced: boolean;
}

function frames(pcm: Int16Array): Frame[] {
  const n = Math.floor(pcm.length / FRAME);
  const rms = new Float32Array(n);
  const zcr = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    let z = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
      e += pcm[i] * pcm[i];
      if (i > f * FRAME && (pcm[i] >= 0) !== (pcm[i - 1] >= 0)) z++;
    }
    rms[f] = Math.sqrt(e / FRAME);
    zcr[f] = z / FRAME;
  }
  const loudLevel = [...rms].sort((a, b) => a - b)[Math.floor(n * 0.9)] ?? 0;
  const threshold = Math.max(120, loudLevel * 0.06);
  return Array.from(rms, (r, f) => ({ rms: r, loud: r >= threshold, voiced: r >= threshold && zcr[f] < MAX_ZCR_VOICED }));
}

/** Stretches of sound [start, end) in frames, split at pauses of PAUSE_FRAMES or more. */
function stretches(fr: Frame[]): [number, number][] {
  const out: [number, number][] = [];
  let f = 0;
  while (f < fr.length) {
    while (f < fr.length && !fr[f].loud) f++;
    if (f >= fr.length) break;
    const start = f;
    let end = f;
    let quiet = 0;
    for (; f < fr.length; f++) {
      if (fr[f].loud) {
        end = f + 1;
        quiet = 0;
      } else if (++quiet >= PAUSE_FRAMES) break;
    }
    out.push([start, end]);
  }
  return out;
}

const voicedIn = (fr: Frame[], [a, b]: [number, number]) => {
  let n = 0;
  for (let f = a; f < b; f++) if (fr[f].voiced) n++;
  return n;
};

const peak = (fr: Frame[], [a, b]: [number, number]) => {
  let p = 0;
  for (let f = a; f < b; f++) p = Math.max(p, fr[f].rms);
  return p;
};

/** The end-of-response burst: short, loud, after a pause, and still loud when the audio stops. */
const isEndBurst = (fr: Frame[], st: [number, number][], i: number) =>
  i > 0 && st[i][1] >= fr.length - PAUSE_FRAMES && st[i][1] - st[i][0] <= BURST_FRAMES && peak(fr, st[i]) >= BURST_RMS;

/**
 * The part of `pcm` [start, end) in samples without noise at its edges. `edges` limits the
 * check to one side (for a window cut from the middle of a longer clip).
 */
export function speechSpan(pcm: Int16Array, edges: { start?: boolean; end?: boolean } = { start: true, end: true }): [number, number] {
  const fr = frames(pcm);
  const st = stretches(fr);
  if (!st.length) return [0, pcm.length];
  const speech = (i: number) => voicedIn(fr, st[i]) >= MIN_VOICED_FRAMES;
  let lo = 0;
  let hi = st.length - 1;
  if (edges.end && isEndBurst(fr, st, hi)) hi--;
  // Keep at least one stretch with speech, whatever the edges look like.
  if (edges.end) while (hi > lo && !speech(hi)) hi--;
  if (edges.start) while (lo < hi && !speech(lo)) lo++;
  if (!speech(hi)) return hi === st.length - 1 ? [0, pcm.length] : [0, Math.min(st[hi + 1][0] * FRAME, st[hi][1] * FRAME + PAD)];

  let start = 0;
  let end = pcm.length;
  if (edges.end) {
    const [, b] = st[hi];
    let v = b - 1;
    while (!fr[v].voiced) v--;
    if (b - 1 - v > MAX_UNVOICED_TAIL) end = (v + 1 + KEEP_TAIL) * FRAME; // static stuck to the last word
    else if (hi < st.length - 1) end = Math.min(st[hi + 1][0] * FRAME, b * FRAME + PAD); // noise after a pause
  }
  if (edges.start) {
    const [a] = st[lo];
    let v = a;
    while (!fr[v].voiced) v++;
    if (v - a > MAX_UNVOICED_TAIL) start = (v - KEEP_TAIL) * FRAME;
    else if (lo > 0) start = Math.max(st[lo - 1][1] * FRAME, a * FRAME - PAD);
  }
  return [start, Math.max(start, end)];
}

/**
 * Silences end-of-response bursts inside audio joined from several responses (podcast episodes
 * made before chunks were cleaned), keeping its length so transcript timing still matches. A
 * burst there is a short loud stretch after a pause that is cut off while still loud (rising to
 * its last frame, then digital silence), which speech never is. Returns how many were silenced.
 */
export function silenceBursts(pcm: Int16Array): number {
  const fr = frames(pcm);
  const st = stretches(fr);
  let n = 0;
  st.forEach(([a, b], i) => {
    if (i === 0 || b - a > BURST_FRAMES) return;
    const top = peak(fr, [a, b]);
    const lastLoud = fr[b - 1].rms >= top * 0.6;
    const thenSilent = b >= fr.length || fr[b].rms < 50;
    if (top < BURST_RMS || !lastLoud || !thenSilent) return;
    pcm.fill(0, a * FRAME, Math.min(pcm.length, b * FRAME));
    n++;
  });
  return n;
}

const WINDOW_BYTES = RATE * 2 * 3; // 3 s

/**
 * speechSpan for a stored clip (raw 16-bit samples) as byte offsets, reading only its first and
 * last few seconds.
 */
export async function blobSpan(pcm: Blob): Promise<[number, number]> {
  if (pcm.size <= WINDOW_BYTES * 2) {
    const [a, b] = speechSpan(new Int16Array(await pcm.arrayBuffer()));
    return [a * 2, b * 2];
  }
  const head = new Int16Array(await pcm.slice(0, WINDOW_BYTES).arrayBuffer());
  const tail = new Int16Array(await pcm.slice(pcm.size - WINDOW_BYTES).arrayBuffer());
  const [a] = speechSpan(head, { start: true });
  const [, b] = speechSpan(tail, { end: true });
  return [a * 2, pcm.size - WINDOW_BYTES + b * 2];
}
