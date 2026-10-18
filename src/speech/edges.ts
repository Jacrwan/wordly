import { RATE } from '../ai/tts';

// Gemini TTS can end (or start) a response with a burst of static: loud, so silence trimming
// keeps it, and heard as a harsh "chzz" at the end of a word list or text before it loops.
// Static has no voicing, while every spoken word has vowels, so loud stretches at the edges with
// no voiced frames are dropped, and a long voiceless tail stuck to the last word is cut short.
// Voicing is judged by zero-crossing rate (vowels cross zero rarely; hiss and static constantly),
// which is cheap enough to run on every clip.

const FRAME = RATE / 50; // 20 ms
const PAUSE_FRAMES = 5; // 100 ms of quiet separates two stretches of sound
const MAX_ZCR_VOICED = 0.22;
const MIN_VOICED_FRAMES = 3; // a stretch with fewer voiced frames than this is not speech
const MAX_UNVOICED_TAIL = 15; // 300 ms: longer than any final "s"/"sh" the voice makes
const KEEP_TAIL = 4; // 80 ms of a final fricative is kept
const PAD = Math.round(RATE * 0.08);

interface Frame {
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
  return Array.from(rms, (r, f) => ({ loud: r >= threshold, voiced: r >= threshold && zcr[f] < MAX_ZCR_VOICED }));
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

/**
 * The part of `pcm` [start, end) in samples without static at its edges. `edges` limits the
 * check to one side (for a window cut from the middle of a longer clip).
 */
export function speechSpan(pcm: Int16Array, edges: { start?: boolean; end?: boolean } = { start: true, end: true }): [number, number] {
  const fr = frames(pcm);
  const st = stretches(fr);
  // Keep at least one stretch with speech, whatever the edges look like.
  let lo = 0;
  let hi = st.length - 1;
  if (edges.end) while (hi > lo && voicedIn(fr, st[hi]) < MIN_VOICED_FRAMES) hi--;
  if (edges.start) while (lo < hi && voicedIn(fr, st[lo]) < MIN_VOICED_FRAMES) lo++;
  if (!st.length || voicedIn(fr, st[hi]) < MIN_VOICED_FRAMES) return [0, pcm.length];

  let start = 0;
  let end = pcm.length;
  if (edges.end) {
    const [, b] = st[hi];
    let v = b - 1;
    while (!fr[v].voiced) v--;
    if (b - 1 - v > MAX_UNVOICED_TAIL) end = (v + 1 + KEEP_TAIL) * FRAME; // static stuck to the last word
    else if (hi < st.length - 1) end = Math.min(st[hi + 1][0] * FRAME, b * FRAME + PAD); // static after a pause
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
