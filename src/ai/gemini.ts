import type { ModelChoice, Settings } from '../db/schema';
import { PROXY_URL } from './config';

const GOOGLE = 'https://generativelanguage.googleapis.com';

/** How the app reaches Gemini: the family proxy (default) or the user's own key. */
export type Conn = { kind: 'proxy'; code: string } | { kind: 'key'; key: string };

export function connFrom(s: Pick<Settings, 'apiKey' | 'familyCode'>): Conn | null {
  if (s.apiKey) return { kind: 'key', key: s.apiKey };
  if (s.familyCode) return { kind: 'proxy', code: s.familyCode };
  return null;
}

export type GeminiErrorKind =
  | 'invalid-key' // the user's own key was rejected
  | 'bad-code' // wrong family code
  | 'rate-limit'
  | 'proxy-config' // proxy is missing secrets or holds a bad key
  | 'network'
  | 'http';

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number; // from Google's RetryInfo on 429s

  constructor(message: string, kind: GeminiErrorKind, status?: number, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ModelInfo {
  id: string; // e.g. "gemini-flash-latest" (without the "models/" prefix)
  displayName: string;
  methods: string[];
}

export async function request<T>(conn: Conn, path: string, init: RequestInit = {}): Promise<T> {
  const base = conn.kind === 'proxy' ? PROXY_URL : GOOGLE;
  const headers = new Headers(init.headers);
  if (conn.kind === 'proxy') headers.set('X-Family-Code', conn.code);
  else headers.set('x-goog-api-key', conn.key);
  if (init.body) headers.set('Content-Type', 'application/json');

  let res: Response;
  try {
    res = await fetch(`${base}/v1beta/${path}`, { ...init, headers });
  } catch {
    throw new GeminiError('network error', 'network');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg: string = body?.error?.message ?? res.statusText;
    const retry = (body?.error?.details ?? []).find((d: { retryDelay?: string }) => d.retryDelay)?.retryDelay;
    const retryAfterMs = retry ? Math.ceil(parseFloat(retry) * 1000) : undefined;
    throw new GeminiError(msg, errorKind(conn, res.status, body?.error?.code, msg), res.status, retryAfterMs);
  }
  return res.json();
}

function errorKind(conn: Conn, status: number, code: unknown, msg: string): GeminiErrorKind {
  if (status === 429) return 'rate-limit';
  if (code === 'FAMILY_CODE') return 'bad-code';
  if (code === 'CONFIG' || code === 'ORIGIN') return 'proxy-config';
  const keyRejected = (status === 400 || status === 401 || status === 403) && /key/i.test(msg);
  if (keyRejected) return conn.kind === 'proxy' ? 'proxy-config' : 'invalid-key';
  return 'http';
}

export async function listModels(conn: Conn): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let pageToken = '';
  do {
    const q = `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await request<{
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    }>(conn, q);
    for (const m of page.models ?? []) {
      out.push({
        id: m.name.replace(/^models\//, ''),
        displayName: m.displayName ?? m.name,
        methods: m.supportedGenerationMethods ?? [],
      });
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

// Extracts a sortable version from names like "gemini-2.5-flash" → [2, 5].
function version(id: string): number[] {
  const m = id.match(/^gemini-(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : [0];
}

function newest(ids: string[]): string | null {
  const sorted = [...ids].sort((a, b) => {
    const va = version(a);
    const vb = version(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d) return d;
    }
    return a.length - b.length; // prefer the shorter (non-dated) name
  });
  return sorted[0] ?? null;
}

// Variants that are not general text models.
const SPECIAL = /(lite|image|live|audio|tts|embedding|thinking|exp|learnlm|robotics|computer-use|aqa)/;

function pickFamily(ids: string[], family: 'flash' | 'pro'): string | null {
  const alias = `gemini-${family}-latest`;
  if (ids.includes(alias)) return alias;
  const stable = ids.filter((id) => new RegExp(`^gemini-[\\d.]+-${family}(-\\d{3})?$`).test(id));
  if (stable.length) return newest(stable);
  const preview = ids.filter((id) => id.startsWith('gemini-') && id.includes(`-${family}`) && !SPECIAL.test(id));
  return newest(preview);
}

/** The fast model plus a lighter one with its own rate limit, for lookups and notes. */
export function lookupModels(choice: ModelChoice | null): string[] {
  if (!choice?.lookup) return [];
  const lite = choice.available.includes('gemini-flash-lite-latest')
    ? 'gemini-flash-lite-latest'
    : choice.available.filter((id) => /^gemini-[\d.]+-flash-lite$/.test(id)).sort().pop();
  return lite ? [choice.lookup, lite] : [choice.lookup];
}

export function pickModels(models: ModelInfo[]): ModelChoice {
  const generative = models.filter((m) => m.methods.includes('generateContent')).map((m) => m.id);
  const lookup = pickFamily(generative, 'flash');
  const tts = generative.filter((id) => id.includes('tts'));
  return {
    lookup,
    long: pickFamily(generative, 'pro') ?? lookup,
    // Flash TTS is preferred for speed; Pro TTS only if that's all there is.
    tts: newest(tts.filter((id) => id.includes('flash'))) ?? newest(tts),
    available: generative.sort(),
    checkedAt: Date.now(),
  };
}

export interface JsonRequest {
  /** Models to try in order; later ones are used when earlier ones are rate-limited. */
  models: string[];
  system: string;
  prompt: string;
  schema: object; // Gemini responseSchema (OpenAPI subset)
  temperature?: number;
  /** "low" skips most hidden reasoning: ~3 s instead of ~4+ s for dictionary-style answers. */
  thinkingLevel?: 'low' | 'high';
  /** Called when every model is rate-limited and we're waiting to retry. */
  onWait?: (ms: number) => void;
}

const MAX_RETRY_WAIT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * generateContent with structured JSON output. The free tier allows ~5 requests per minute
 * per model, so a 429 moves on to the next model, and if all are busy we wait once for
 * the delay Google suggests.
 */
export async function generateJSON<T>(conn: Conn, req: JsonRequest): Promise<{ data: T; model: string }> {
  const models = [...new Set(req.models.filter(Boolean))];
  let waited = false;
  for (;;) {
    let shortestWait = Infinity;
    for (const model of models) {
      try {
        return { data: await generateOnce<T>(conn, model, req), model };
      } catch (e) {
        if (!(e instanceof GeminiError) || e.kind !== 'rate-limit') throw e;
        shortestWait = Math.min(shortestWait, e.retryAfterMs ?? 60_000);
        if (model === models[models.length - 1] && (waited || shortestWait > MAX_RETRY_WAIT_MS)) throw e;
      }
    }
    waited = true;
    req.onWait?.(shortestWait);
    await sleep(shortestWait + 500);
  }
}

async function generateOnce<T>(conn: Conn, model: string, req: JsonRequest, withThinking = true): Promise<T> {
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: req.schema,
      temperature: req.temperature ?? 0.4,
      ...(req.thinkingLevel && withThinking ? { thinkingConfig: { thinkingLevel: req.thinkingLevel } } : {}),
    },
  };
  let res: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] };
  try {
    res = await request(conn, `models/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    // Some models don't accept thinking settings; ask again without them.
    if (withThinking && req.thinkingLevel && e instanceof GeminiError && e.status === 400 && /think/i.test(e.message)) {
      return generateOnce<T>(conn, model, req, false);
    }
    throw e;
  }
  const cand = res.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`Unreadable response (${cand?.finishReason ?? 'no candidates'})`, 'http');
  }
}
