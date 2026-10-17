import type { Settings } from '../db/schema';
import { byHealth, coolDown, GeminiError, request, type Conn } from './gemini';

// Gemini text-to-speech, shared by podcasts and the lock-screen word player. Responses are
// 24 kHz 16-bit mono PCM (sometimes wrapped in a WAV header). Each TTS model has its own small
// free daily allowance, so a model that runs out is skipped for a while (see coolDown).

export const RATE = 24000;
const TIMEOUT_MS = 120_000;
const MAX_WAIT_MS = 65_000;

/** TTS models this key can use, preferred first. */
export function ttsModels(settings: Settings): string[] {
  const avail = settings.models?.available ?? [];
  const list = [settings.models?.tts, 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'];
  return [...new Set(list.filter((m): m is string => !!m && avail.includes(m)))];
}

type AudioResponse = { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[] };

/**
 * One generateContent request with responseModalities AUDIO → PCM samples. A busy or used-up
 * model moves on to the next; if every model is only briefly busy (per-minute limit), waits
 * once. Throws a rate-limit GeminiError when nothing is left (`daily` when the day's quota is gone).
 */
export async function synthesize(conn: Conn, models: string[], body: object, opts: { onWait?: (ms: number) => void; cancel?: AbortSignal } = {}): Promise<{ pcm: Int16Array; model: string }> {
  if (opts.cancel?.aborted) throw new GeminiError('cancelled', 'http', 0);
  const list = byHealth(models);
  let waited = false;
  for (;;) {
    let last: unknown = new GeminiError('no TTS model', 'rate-limit', 0, undefined, true);
    let shortestWait = Infinity;
    let allDaily = true;
    for (const model of list) {
      if (opts.cancel?.aborted) throw new GeminiError('cancelled', 'http', 0);
      try {
        const res = await request<AudioResponse>(conn, `models/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body) }, TIMEOUT_MS, opts.cancel);
        const inline = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
        if (!inline) throw new GeminiError('no audio in response', 'http');
        return { pcm: pcmFrom(inline.data, inline.mimeType), model };
      } catch (e) {
        last = e;
        if (opts.cancel?.aborted) throw e;
        // Try the next TTS model on quota/overload/unavailable; anything else is final.
        if (!(e instanceof GeminiError) || (e.kind !== 'rate-limit' && e.status !== 404 && e.status !== 400)) throw e;
        if (e.kind === 'rate-limit') {
          coolDown(model, e);
          if (!e.daily) {
            allDaily = false;
            shortestWait = Math.min(shortestWait, e.retryAfterMs ?? 60_000);
          }
        }
      }
    }
    if (waited || allDaily || shortestWait > MAX_WAIT_MS) throw last;
    waited = true;
    opts.onWait?.(shortestWait);
    await new Promise((r) => setTimeout(r, shortestWait + 500));
    if (opts.cancel?.aborted) throw new GeminiError('cancelled', 'http', 0);
  }
}

export function pcmFrom(b64: string, mime: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // WAV responses carry a 44-byte header; raw L16 doesn't.
  const offset = mime.includes('wav') && bin.startsWith('RIFF') ? 44 : 0;
  return new Int16Array(bytes.buffer.slice(offset, offset + ((bytes.length - offset) >> 1) * 2));
}

/** A WAV file from PCM pieces: sample arrays, or Blobs of raw samples (e.g. cached clips, not copied). */
export function wavBlob(parts: (Int16Array | Blob)[]): Blob {
  const samples = parts.reduce((n, p) => n + (p instanceof Blob ? p.size >> 1 : p.length), 0);
  const header = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); header.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
  header.setUint32(24, RATE, true); header.setUint32(28, RATE * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
  str(36, 'data'); header.setUint32(40, samples * 2, true);
  return new Blob([header.buffer, ...parts.map(pcmPart)], { type: 'audio/wav' });
}

/** A Blob part for PCM samples; a view into a larger buffer (one word cut from a longer clip) is copied out. */
export function pcmPart(p: Int16Array | Blob): Blob | ArrayBuffer {
  if (p instanceof Blob) return p;
  return (p.byteOffset === 0 && p.byteLength === p.buffer.byteLength ? p : p.slice()).buffer as ArrayBuffer;
}
