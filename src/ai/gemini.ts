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

  constructor(message: string, kind: GeminiErrorKind, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
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
    throw new GeminiError(msg, errorKind(conn, res.status, body?.error?.code, msg), res.status);
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
  model: string;
  system: string;
  prompt: string;
  schema: object; // Gemini responseSchema (OpenAPI subset)
  temperature?: number;
}

/** One generateContent call with structured JSON output. */
export async function generateJSON<T>(conn: Conn, req: JsonRequest): Promise<T> {
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: req.schema,
      temperature: req.temperature ?? 0.4,
    },
  };
  const res = await request<{
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  }>(conn, `models/${req.model}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
  const cand = res.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`Unreadable response (${cand?.finishReason ?? 'no candidates'})`, 'http');
  }
}
