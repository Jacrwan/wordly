import { RATE } from '../ai/tts';

// Cutting one TTS batch (several words read in a row) into one clip per word.
//
// The voice pauses after every sentence (word / Korean / definition / similar words), and the
// gap between two words is not reliably longer than those, so cutting near a length-based guess
// for each word goes wrong. Instead every sentence end is matched, in order, to a detected pause
// (a small dynamic program), so a poor length guess only shifts one sentence. Neighbouring words
// are read by different voices (female / male), so the pitch of the speech between pauses also
// tells which word it belongs to; that settles the short sentences (a lone "fever.") that length
// alone can put on the wrong side of a cut.

const FRAME = RATE / 50; // 20 ms
const MIN_PAUSE_FRAMES = 6; // 120 ms
const EDGE_PAD = Math.round(RATE * 0.08);
const MAX_MERGE = 4; // sentence ends in a row that may have no detectable pause
const MERGE_COST = 1.5;
const PAUSE_BONUS = 0.5;
const PITCH_COST = 4; // per second of speech in the other voice's pitch range

// Seconds per sentence ≈ base + per Latin letter + per Hangul syllable + per comma. These priors
// are refitted to each batch's own audio after a first alignment (the voice's pace varies).
type Rates = [number, number, number, number];
const PRIOR: Rates = [0.25, 0.062, 0.16, 0.15];

interface Pause {
  start: number; // frames
  end: number;
  mid: number;
  len: number;
}

/**
 * Cuts one batch's audio into one piece per entry (each entry given as its sentences), trimmed of
 * edge silence. `voices[i]` (0 or 1) is which of the two voices read entry i.
 */
export function splitAtPauses(pcm: Int16Array, entries: string[][], voices?: number[]): Int16Array[] {
  const frames = Math.floor(pcm.length / FRAME);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(sum / FRAME);
  }
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(frames * 0.9)] ?? 0;
  const threshold = Math.max(120, loud * 0.06);
  const quiet = Array.from(rms, (r) => r < threshold);
  // A single louder frame (a click or breath) doesn't end a pause.
  for (let f = 1; f + 1 < frames; f++) if (!quiet[f] && quiet[f - 1] && quiet[f + 1]) quiet[f] = true;

  let first = 0;
  while (first < frames && quiet[first]) first++;
  let last = frames - 1;
  while (last > first && quiet[last]) last--;
  const pauses: Pause[] = [];
  for (let f = first; f <= last; f++) {
    if (!quiet[f]) continue;
    const start = f;
    while (f <= last && quiet[f]) f++;
    if (f - start >= MIN_PAUSE_FRAMES) pauses.push({ start, end: f, mid: (start + f) / 2, len: f - start });
  }

  let cuts: number[] = [];
  if (entries.length > 1) {
    const sentences = entries.map((lines) => lines.map(features));
    const pitch = voices ? pitchLabels(pcm, pauses, first, last) : null;
    // Which voice sounds higher isn't assumed: both ways are tried and the better fit wins.
    const mappings = pitch ? [voices!.map((v) => (v ? 1 : -1)), voices!.map((v) => (v ? -1 : 1))] : [null];
    let best: Alignment | null = null;
    for (const expect of mappings) {
      let rates = PRIOR;
      for (let pass = 0; pass < 3; pass++) {
        const a = alignSentences(sentences, pauses, first, last, rates, pitch && expect ? { ...pitch, expect } : null);
        if (!a) break;
        if (!best || a.cost < best.cost) best = a;
        rates = refit(a.segments);
      }
    }
    cuts = best?.cuts ?? proportionalCuts(sentences, pauses, first, last);
  }
  const bounds = [0, ...cuts.map((c) => Math.round(c) * FRAME), pcm.length];
  return entries.map((_, i) => trim(pcm.subarray(bounds[i], bounds[i + 1]), threshold));
}

function features(text: string): Rates {
  const f: Rates = [1, 0, 0, 0];
  for (const ch of text) {
    if (/[가-힣]/.test(ch)) f[2]++;
    else if (/[\p{L}\p{N}]/u.test(ch)) f[1]++;
    else if (ch === ',') f[3]++;
  }
  return f;
}

const dot = (a: Rates, b: Rates) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

/** Least squares for the rates, pulled toward the priors (ridge) so a few sentences can't run away. */
function refit(segments: { f: Rates; d: number }[]): Rates {
  const scale = [1, 30, 10, 2]; // typical feature sizes, so the pull is even across rates
  const A = Array.from({ length: 4 }, (_, i) => Array.from({ length: 5 }, (_, j) => (j === i ? 2 * scale[i] ** 2 : 0)));
  for (let i = 0; i < 4; i++) A[i][4] = 2 * scale[i] ** 2 * PRIOR[i];
  for (const { f, d } of segments) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) A[i][j] += f[i] * f[j];
      A[i][4] += f[i] * d;
    }
  }
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c || !A[c][c]) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j < 5; j++) A[r][j] -= k * A[c][j];
    }
  }
  const w = A.map((row, i) => (row[i] ? row[4] / row[i] : PRIOR[i])) as Rates;
  // Keep every rate positive and within a sane range of its prior.
  return w.map((x, i) => Math.min(PRIOR[i] * 3, Math.max(PRIOR[i] / 3, x))) as Rates;
}

// ---------------------------------------------------------------- pitch

interface PitchLabels {
  high: Float64Array; // prefix sums over the speech between anchors: seconds that sound high
  low: Float64Array; // … and low
}

/**
 * Labels the speech between each pair of neighbouring anchors (start, pauses, end) as the higher
 * or lower voice, by median pitch. Null when the batch doesn't split into two clear pitch groups.
 */
function pitchLabels(pcm: Int16Array, pauses: Pause[], first: number, last: number): PitchLabels | null {
  const gaps = pauses.length + 1;
  const hz: number[] = [];
  const secs: number[] = [];
  for (let g = 0; g < gaps; g++) {
    const from = (g === 0 ? first : pauses[g - 1].end) * FRAME;
    const to = (g === pauses.length ? last + 1 : pauses[g].start) * FRAME;
    hz.push(medianPitch(pcm, from, to));
    secs.push((to - from) / RATE);
  }
  // Two groups on a log scale: the split with the largest between-group spread.
  const logs = hz.filter((h) => h > 0).map(Math.log).sort((a, b) => a - b);
  if (logs.length < 4) return null;
  let split = 0;
  let bestSpread = -1;
  for (let i = 1; i < logs.length; i++) {
    const lo = logs.slice(0, i);
    const hi = logs.slice(i);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const spread = lo.length * hi.length * (mean(hi) - mean(lo)) ** 2;
    if (spread > bestSpread) {
      bestSpread = spread;
      split = (logs[i - 1] + logs[i]) / 2;
    }
  }
  const loMean = logs.filter((x) => x < split);
  const hiMean = logs.filter((x) => x >= split);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (avg(hiMean) - avg(loMean) < Math.log(1.35)) return null; // one voice, or pitch too unclear

  const high = new Float64Array(gaps + 1);
  const low = new Float64Array(gaps + 1);
  for (let g = 0; g < gaps; g++) {
    const h = hz[g] > 0 ? Math.log(hz[g]) : NaN;
    high[g + 1] = high[g] + (h >= split ? secs[g] : 0);
    low[g + 1] = low[g] + (h < split ? secs[g] : 0);
  }
  return { high, low };
}

/** Median pitch (Hz) of a stretch of speech by autocorrelation, or 0 when none is clear. */
function medianPitch(pcm: Int16Array, from: number, to: number): number {
  const WIN = 1024; // at half rate: ≈ 85 ms
  const minLag = Math.floor(RATE / 2 / 400);
  const maxLag = Math.ceil(RATE / 2 / 70);
  const x = new Float32Array(WIN + maxLag);
  const found: number[] = [];
  const span = to - from - (WIN + maxLag) * 2;
  if (span <= 0) return 0;
  const windows = Math.min(8, Math.max(1, Math.floor(span / RATE / 0.15)));
  for (let w = 0; w < windows; w++) {
    const start = from + Math.floor((span * (w + 0.5)) / windows);
    for (let i = 0; i < x.length; i++) x[i] = pcm[start + i * 2];
    let energy = 0;
    for (let i = 0; i < WIN; i++) energy += x[i] * x[i];
    if (!energy) continue;
    const r = new Float32Array(maxLag + 1);
    let top = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      let e2 = 0;
      for (let i = 0; i < WIN; i++) {
        sum += x[i] * x[i + lag];
        e2 += x[i + lag] * x[i + lag];
      }
      r[lag] = sum / Math.sqrt(energy * e2 || 1);
      top = Math.max(top, r[lag]);
    }
    if (top < 0.5) continue; // unvoiced
    // The shortest lag close to the best one avoids reading half the pitch (an octave too low).
    let lag = minLag;
    while (lag < maxLag && !(r[lag] >= 0.9 * top && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1])) lag++;
    found.push(RATE / 2 / lag);
  }
  if (!found.length) return 0;
  found.sort((a, b) => a - b);
  return found[Math.floor(found.length / 2)];
}

// ---------------------------------------------------------------- alignment

interface Alignment {
  cuts: number[]; // frame of each cut between entries
  segments: { f: Rates; d: number }[]; // features and measured seconds between matched pauses
  cost: number;
}

/**
 * Matches every sentence end to a pause (or lets up to MAX_MERGE in a row go without one; never
 * the end of an entry), minimising how far each sentence's length strays from its estimate and
 * how much of it sounds like the other voice, while preferring longer pauses. Null if impossible.
 */
function alignSentences(entries: Rates[][], pauses: Pause[], first: number, last: number, rates: Rates,
  pitch: (PitchLabels & { expect: number[] }) | null): Alignment | null {
  const feat: Rates[] = [[0, 0, 0, 0]]; // feat[s] for sentence s (1-based)
  const entryEnd: boolean[] = [false]; // boundary s (after sentence s) ends an entry
  const entryOf: number[] = [0];
  entries.forEach((lines, e) => lines.forEach((f, j) => {
    feat.push(f);
    entryEnd.push(j === lines.length - 1);
    entryOf.push(e);
  }));
  const est = feat.map((f, s) => (s ? dot(f, rates) : 0)); // estimated seconds of sentence s
  const m = est.length - 1;
  const scale = (last - first) / 50 / est.reduce((a, b) => a + b, 0);
  // Anchors: the start of speech, every pause, the end of speech (times in seconds).
  const at = [first / 50, ...pauses.map((p) => p.mid / 50), last / 50];
  const bonus = [0, ...pauses.map((p) => (PAUSE_BONUS * Math.min(p.len / 50, 1.2)) / 0.3), 0];
  const K = at.length - 1;
  const offVoice = (e: number, a0: number, a: number) => {
    if (!pitch) return 0;
    const other = pitch.expect[e] > 0 ? pitch.low : pitch.high;
    return PITCH_COST * (other[a] - other[a0]);
  };

  const cost: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(K + 1).fill(Infinity));
  const from: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array((K + 1) * 2).fill(-1));
  cost[0][0] = 0;
  for (let b = 1; b <= m; b++) {
    const lo = b === m ? K : 1;
    const hi = b === m ? K : K - 1;
    for (let a = lo; a <= hi; a++) {
      const reward = b === m ? 0 : bonus[a] * (entryEnd[b] ? 1.5 : 1);
      let sum = 0;
      for (let b0 = b - 1; b0 >= Math.max(0, b - 1 - MAX_MERGE); b0--) {
        sum += est[b0 + 1];
        if (b0 < b - 1 && entryEnd[b0 + 1]) break; // an entry end can't be skipped
        const want = sum * scale;
        const sigma = 0.2 * want + 0.35;
        const merged = (b - b0 - 1) * MERGE_COST;
        for (let a0 = b0 === 0 ? 0 : 1; a0 < a; a0++) {
          const c0 = cost[b0][a0];
          if (c0 === Infinity) continue;
          const d = (at[a] - at[a0] - want) / sigma;
          const c = c0 + d * d + merged - reward + offVoice(entryOf[b], a0, a);
          if (c < cost[b][a]) {
            cost[b][a] = c;
            from[b][a * 2] = b0;
            from[b][a * 2 + 1] = a0;
          }
        }
      }
    }
  }
  if (cost[m][K] === Infinity) return null;

  const cuts: number[] = [];
  const segments: Alignment['segments'] = [];
  for (let b = m, a = K; b > 0; ) {
    const b0 = from[b][a * 2];
    const a0 = from[b][a * 2 + 1];
    if (b0 > 0 && entryEnd[b0]) cuts.unshift(pauses[a0 - 1].mid);
    const f: Rates = [0, 0, 0, 0];
    for (let s = b0 + 1; s <= b; s++) for (let i = 0; i < 4; i++) f[i] += feat[s][i];
    segments.push({ f, d: at[a] - at[a0] });
    b = b0;
    a = a0;
  }
  return cuts.length === entries.length - 1 ? { cuts, segments, cost: cost[m][K] } : null;
}

/** Fallback: cuts by estimated length, each moved to the longest pause nearby. */
function proportionalCuts(entries: Rates[][], pauses: Pause[], first: number, last: number): number[] {
  const lengths = entries.map((lines) => lines.reduce((n, f) => n + dot(f, PRIOR), 0));
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
  return cuts;
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
