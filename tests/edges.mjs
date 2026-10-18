import { rolldown } from 'rolldown';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const build = await rolldown({ input: 'src/speech/edges.ts', platform: 'node', transform: { define: { 'import.meta.env': '{}' } } });
const dir = await mkdtemp(join(tmpdir(), 'wordly-edges-'));
await build.write({ file: join(dir, 'edges.mjs'), format: 'esm' });
const { speechSpan, blobSpan } = await import(pathToFileURL(join(dir, 'edges.mjs')));
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
console.log('Static at the edges is removed; speech, short fricatives and clean audio are kept.');
