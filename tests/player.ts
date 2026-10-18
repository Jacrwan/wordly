// Open only on the dedicated test origin: http://localhost:5175/wordly/tests/player.html
// This uses synthetic tones, never sends a Gemini request, and seeds only an empty test DB.
import { db, defaultSettings } from '../src/db/schema';
import { batches, buildSession, cachedClips, makeClips, type ClipItem } from '../src/speech/clips';
import { RATE } from '../src/ai/tts';
const output = document.querySelector('#results')!;
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
let requests = 0;
let quota = sessionStorage.getItem('quota-test') === 'yes';
const conn = { kind: 'proxy' as const, code: 'synthetic-test-only' };
const model = 'gemini-3.8-flash-tts';
const items: ClipItem[] = ['fever', 'calm', 'bright', 'run'].map(word => ({ key: word, word, ko: ['뜻'], definition: 'A test definition', synonyms: ['example'] }));
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (!String(input).includes(':generateContent')) return originalFetch(input, init);
  requests++;
  if (quota) return Response.json({error:{message:'Daily quota',details:[{violations:[{quotaId:'RequestsPerDay'}]}]}}, {status:429});
  const body = JSON.parse(String(init?.body));
  const chunks: Int16Array[] = [];
  for (const [i, part] of body.contents[0].parts.entries()) {
    assert(part.speechMetadata?.speaker === (i % 2 ? 'Jake' : 'Mina'), 'speaker metadata');
    for (const line of part.text.split('\n')) {
      const seconds = .25 + [...line].reduce((n,c) => n + (/[가-힣]/.test(c) ? .26 : /[a-z]/i.test(c) ? .062 : 0), 0);
      chunks.push(Int16Array.from({length:Math.round(seconds*RATE)}, (_,j) => 6000*Math.sin(2*Math.PI*(i%2?130:230)*j/RATE)));
      chunks.push(new Int16Array(RATE*.2));
    }
  }
  const pcm = new Int16Array(chunks.reduce((n,c)=>n+c.length,0));
  let offset=0; for(const c of chunks){pcm.set(c,offset);offset+=c.length;}
  const bytes = new Uint8Array(pcm.buffer);
  let binary=''; for(let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'audio/L16;rate=24000',data:btoa(binary)}}]}}]});
};
async function main() {
  assert(location.hostname === 'localhost' && location.port === '5175', 'Use dedicated localhost:5175 test origin');
  const settings = await db.settings.get('app');
  assert(!settings || settings.familyCode === conn.code || sessionStorage.getItem('wordly-test') === 'yes', 'Refusing to alter a non-test database');
  if (!settings) assert(await db.myWords.count() === 0, 'Refusing to alter existing words');
  sessionStorage.setItem('wordly-test','yes');
  if (!settings) {
    await db.settings.put({...defaultSettings, uiLang:'en', familyCode:conn.code, models:{lookup:model,long:model,tts:model,available:[model],checkedAt:Date.now()}});
    await db.myWords.bulkPut(items.map((it,i)=>({word:it.key,display:it.word,ko:it.ko,rank:null,status:i===3?'mastered':'learning',addedAt:100-i,source:'player-test'})));
    await db.cards.put({word:'fever',dir:'en2ko',due:new Date(0),card:{test:true}});
    await db.reviewLogs.add({word:'fever',dir:'en2ko',rating:3,source:'review',ts:100});
    const before = JSON.stringify([await db.cards.toArray(),await db.reviewLogs.toArray(),await db.myWords.toArray()]);
    const result = await makeClips(conn,[model],items,()=>{},new AbortController().signal);
    assert(result.made === 4 && requests === 1,'one request creates four cached clips');
    const clips = await cachedClips(items);
    assert(clips.size===4,'all clips cached');
    const session=buildSession(items,clips)!;
    assert(session.order.length===4 && session.audio.type==='audio/wav','single WAV session');
    const header=new DataView(await session.audio.slice(0,44).arrayBuffer());
    assert(header.getUint32(24,true)===RATE && header.getUint16(34,true)===16 && header.getUint16(22,true)===1,'24 kHz 16-bit mono WAV');
    assert(header.getUint32(40,true)===session.audio.size-44,'WAV payload length');
    assert(Math.abs(session.duration-(session.audio.size-44)/2/RATE)<1e-6,'session timeline matches bytes');
    await db.wordClips.update(['fever','full'],{version:undefined});
    assert(!(await cachedClips(items)).has('fever'),'old inaccurate clips invalidated');
    await db.wordClips.update(['fever','full'],{version:2});
    assert(!(await cachedClips([{...items[0],definition:'Changed'}])).size,'changed text invalidates clip');
    const stop=new AbortController();stop.abort();
    assert((await makeClips(conn,[model],items,()=>{},stop.signal)).stopped==='cancelled' && requests===1,'pre-cancelled operation makes no request');
    assert(batches(Array.from({length:8},(_,i)=>({...items[0],key:String(i),definition:'a'.repeat(200)}))).length>1,'character limit included in batch count');
    quota=true;
    assert((await makeClips(conn,[model],items,()=>{},new AbortController().signal)).stopped==='quota','quota reported without retries');
    quota=false;
    assert(JSON.stringify([await db.cards.toArray(),await db.reviewLogs.toArray(),await db.myWords.toArray()])===before,'generation does not modify FSRS or words');
    sessionStorage.setItem('review-baseline',before);
    // Remove only these test-generated clips so the real player UI exercises generation next.
    await db.wordClips.bulkDelete(items.map(it=>[it.key,'full']));
  }
  requests=0;
  location.hash='/player';
  await import('../src/main');
  setInterval(async()=>{
    const unchanged=JSON.stringify([await db.cards.toArray(),await db.reviewLogs.toArray(),await db.myWords.toArray()])===sessionStorage.getItem('review-baseline');
    output.textContent=`API checks passed. UI TTS requests this load: ${requests}. Cached clips: ${await db.wordClips.count()}. FSRS unchanged: ${unchanged}. Audio: synthetic tones. Media: ${navigator.mediaSession?.metadata?.title ?? 'none'} (${navigator.mediaSession?.playbackState}).\nReload after generating: expect 0 requests.\n`;
  },500);
  const controls=document.createElement('div');
  for(const [label,fn] of [
    ['Test without credentials',async()=>{await db.settings.update('app',{familyCode:'',models:null});location.reload();}],
    ['Test partial quota',async()=>{await db.wordClips.delete(['run','full']);await db.settings.update('app',{familyCode:conn.code,models:{lookup:model,long:model,tts:model,available:[model],checkedAt:Date.now()}});sessionStorage.setItem('quota-test','yes');location.reload();}],
    ['Test empty quota',async()=>{await db.wordClips.bulkDelete(items.map(it=>[it.key,'full']));await db.settings.update('app',{familyCode:conn.code,models:{lookup:model,long:model,tts:model,available:[model],checkedAt:Date.now()}});sessionStorage.setItem('quota-test','yes');location.reload();}],
  ] as const){const b=document.createElement('button');b.textContent=label;b.onclick=fn;controls.append(b);}
  output.after(controls);
}
main().catch(e=>{output.textContent=`FAIL: ${e.message}`;console.error(e);});
