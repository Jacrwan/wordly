import { rolldown } from 'rolldown';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const build = await rolldown({ input: 'src/speech/edges.ts', platform: 'node', transform: { define: { 'import.meta.env': '{}' } } });
const dir = await mkdtemp(join(tmpdir(), 'wordly-edges-'));
await build.write({ file: join(dir, 'edges.mjs'), format: 'esm' });
const { speechSpan, blobSpan, silenceBursts } = await import(pathToFileURL(join(dir, 'edges.mjs')));
await rm(dir, { recursive: true });

const RATE = 24000;
let seed = 7;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const silence = (s) => new Int16Array(Math.round(s * RATE));
// Voiced speech: a 180 Hz tone with harmonics (crosses zero rarely).
const voiced = (s, hz = 180) => Int16Array.from({ length: Math.round(s * RATE) }, (_, i) => {
  const ph = (2 * Math.PI * hz * i) / RATE;
  return 5000 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
});
// Static / hiss: white noise (crosses zero constantly), as loud as the speech.
const noise = (s, amp = 6000) => Int16Array.from({ length: Math.round(s * RATE) }, () => (rand() * 2 - 1) * amp);
const join_ = (...parts) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const secs = ([a, b]) => [+(a / RATE).toFixed(2), +(b / RATE).toFixed(2)];
const near = (got, want, tol = 0.1) => Math.abs(got - want) <= tol;

// 1. Clean speech: untouched.
{
  const pcm = join_(silence(0.3), voiced(1.2), silence(0.4), voiced(0.8), silence(0.3));
  assert.deepEqual(speechSpan(pcm), [0, pcm.length], 'clean audio unchanged');
}
// 2. Static after a pause at the end (speech ends at 2.7 s): cut just after the speech.
{
  const pcm = join_(silence(0.3), voiced(1.2), silence(0.4), voiced(0.8), silence(0.3), noise(0.6), silence(0.2));
  const [a, b] = secs(speechSpan(pcm));
  assert.equal(a, 0, 'start kept');
  assert.ok(near(b, 2.78), `trailing static removed (end ${b})`);
}
// 3. Static stuck directly to the last word: cut 80 ms into it.
{
  const pcm = join_(silence(0.3), voiced(1.5), noise(0.7), silence(0.3));
  const [, b] = secs(speechSpan(pcm));
  assert.ok(near(b, 1.88, 0.05), `attached static cut (end ${b})`);
}
// 4. A word ending in a short "s" (150 ms of hiss) is kept whole.
{
  const pcm = join_(silence(0.3), voiced(0.6), noise(0.15, 3000), silence(0.4));
  assert.deepEqual(speechSpan(pcm), [0, pcm.length], 'final fricative kept');
}
// 5. Static at the start, then a pause, then speech.
{
  const pcm = join_(noise(0.4), silence(0.3), voiced(1.0), silence(0.3));
  const [a] = secs(speechSpan(pcm));
  assert.ok(near(a, 0.62), `leading static removed (start ${a})`);
}
// 6. Only static: left alone (nothing to keep it from).
{
  const pcm = join_(silence(0.2), noise(1.0), silence(0.2));
  assert.deepEqual(speechSpan(pcm), [0, pcm.length], 'all-static audio unchanged');
}
// 7. blobSpan reads only the edges of a long clip and gives byte offsets.
{
  const pcm = join_(silence(0.3), voiced(4), silence(0.5), voiced(4), silence(0.3), noise(0.8), silence(0.2));
  const [a, b] = await blobSpan(new Blob([pcm.buffer]));
  assert.equal(a, 0);
  assert.ok(near(b / 2 / RATE, 8.88), `blobSpan end ${b / 2 / RATE}`);
  assert.equal(b % 2, 0, 'byte offset on a sample boundary');
}
// The real end-of-response burst (measured: ~150 ms, RMS 12,600 → 20,000, ZCR 0.12–0.24, right
// after ~150 ms of near-silence, still loud when the audio stops). A 300 Hz tone crosses zero at
// ZCR 0.025, rising amplitude gives the rising RMS.
const burst = (s = 0.15) => {
  const n = Math.round(s * RATE);
  return Int16Array.from({ length: n }, (_, i) => (17800 + 10500 * (i / n)) * Math.sin((2 * Math.PI * 300 * i) / RATE));
};
// 8. Speech, a short pause, then the burst to the very end: cut back to the speech.
{
  const pcm = join_(silence(0.3), voiced(1.2), silence(0.3), voiced(0.9), silence(0.15), burst());
  const [a, b] = secs(speechSpan(pcm));
  assert.equal(a, 0);
  assert.ok(b <= 2.7 + 0.15 && b >= 2.7, `end burst removed (end ${b}, speech ends 2.70, burst starts 2.85)`);
  // Through the edge-only reader used for cached clips too.
  const long = join_(silence(0.3), voiced(4), silence(0.5), voiced(3), silence(0.15), burst());
  const [, bb] = await blobSpan(new Blob([long.buffer]));
  assert.ok(near(bb / 2 / RATE, 7.88, 0.08), `cached clip burst removed (end ${bb / 2 / RATE})`);
}
// 9. A short final word at normal loudness followed by silence is kept.
{
  const pcm = join_(silence(0.3), voiced(1.2), silence(0.2), voiced(0.3), silence(0.4));
  assert.deepEqual(speechSpan(pcm), [0, pcm.length], 'short last word kept');
}
// 10. Podcast joined from chunks: the burst at a join is silenced (length kept); a loud word that
// fades out naturally is not.
{
  const fadeWord = (s) => { const w = voiced(s); for (let i = 0; i < w.length; i++) w[i] *= 2.2 * (1 - i / w.length); return w; };
  const chunk1 = join_(silence(0.3), voiced(2), silence(0.3), fadeWord(0.3), silence(0.15), burst());
  const chunk2 = join_(silence(0.25), voiced(2), silence(0.15), burst());
  const pcm = join_(chunk1, chunk2);
  const before = pcm.length;
  const loudWordAt = Math.round((0.3 + 2 + 0.3 + 0.1) * RATE);
  const loudWordSample = pcm[loudWordAt];
  const n = silenceBursts(pcm);
  assert.equal(n, 2, `both bursts silenced (got ${n})`);
  assert.equal(pcm.length, before, 'length unchanged');
  assert.equal(pcm[loudWordAt], loudWordSample, 'fading loud word untouched');
  const burstMid = chunk1.length - Math.round(0.07 * RATE);
  assert.equal(pcm[burstMid], 0, 'burst samples zeroed');
}
console.log('Static and the end-of-response burst are removed; speech, short words, fricatives and clean audio are kept.');
