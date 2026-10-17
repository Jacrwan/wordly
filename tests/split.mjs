import { rolldown } from 'rolldown';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const build = await rolldown({ input: 'src/speech/split.ts', platform: 'node', transform: { define: { 'import.meta.env': '{}' } } });
const dir = await mkdtemp(join(tmpdir(), 'wordly-split-'));
await build.write({ file: join(dir, 'split.mjs'), format: 'esm' });
const { splitAtPauses } = await import(pathToFileURL(join(dir, 'split.mjs')));
await rm(dir, { recursive: true });
const RATE = 24000;
const entries = [
 ['fever.', '열, 발열.', 'An unusually high body temperature.', 'Similar words: heat, temperature.'],
 ['calm.', '차분한, 평온한, 조용한.', 'Without worry or strong emotion.', 'Similar words: peaceful, quiet.'],
 ['bright.', '밝은, 빛나는, 영리한.', 'Giving out or reflecting much light.', 'Similar words: shining, clever.'],
 ['run.', '달리다, 운영하다.', 'To move quickly on foot.', 'Similar words: sprint, race.'],
];
let seed = 42;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
let failures = 0;
for (let test = 0; test < 100; test++) {
 const chunks = [], expected = [];
 const gap = s => chunks.push(new Int16Array(Math.round(s * RATE)));
 gap(.2);
 for (let e = 0; e < entries.length; e++) {
   let speech = 0;
   for (const text of entries[e]) {
     const ko = [...text].filter(c => /[가-힣]/.test(c)).length;
     const latin = [...text].filter(c => /[a-z]/i.test(c)).length;
     const d = (.25 + latin * .062 + ko * (.24 + rand() * .08)) * (.85 + rand() * .3);
     const n = Math.round(d * RATE), hz = (e % 2 ? 130 : 230) * (.94 + rand() * .12);
     const pcm = Int16Array.from({length:n}, (_, i) => 6000 * Math.sin(2 * Math.PI * hz * i / RATE));
     if (text.includes(',')) {
       const mid = Math.floor(n * .45);
       chunks.push(pcm.subarray(0, mid));
       gap(.14 + rand() * .15);
       chunks.push(pcm.subarray(mid));
     } else chunks.push(pcm);
     speech += n;
     gap(.14 + rand() * .4);
   }
   expected.push(speech);
 }
 const pcm = new Int16Array(chunks.reduce((n,c)=>n+c.length,0));
 let off=0; for(const c of chunks){pcm.set(c,off);off+=c.length;}
 const pieces=splitAtPauses(pcm,entries,[0,1,0,1]);
 for(let i=0;i<pieces.length;i++) {
   const voiced=pieces[i].reduce((n,v)=>n+(Math.abs(v)>5?1:0),0);
   const ratio=voiced/expected[i];
   if(ratio < .97 || ratio > 1.02) {failures++;break;}
 }
}
console.log({runs:100,failures});
assert.equal(failures,0);

assert.throws(() => splitAtPauses(new Int16Array(24000), entries, [0, 1, 0, 1]), /silence/);
assert.throws(() => splitAtPauses(Int16Array.from({length:24000}, (_,i)=>6000*Math.sin(i)), entries), /boundaries/);
assert.deepEqual(splitAtPauses(new Int16Array(), []), []);
console.log('Silent and unsplittable responses rejected without caching guessed clips.');
