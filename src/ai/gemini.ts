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
  readonly daily?: boolean; // the model's free daily allowance is used up

  constructor(message: string, kind: GeminiErrorKind, status?: number, retryAfterMs?: number, daily?: boolean) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.daily = daily;
  }
}

export interface ModelInfo {
  id: string; // e.g. "gemini-flash-latest" (without the "models/" prefix)
  displayName: string;
  methods: string[];
}

export async function request<T>(conn: Conn, path: string, init: RequestInit = {}, timeoutMs = 0, cancel?: AbortSignal): Promise<T> {
  const base = conn.kind === 'proxy' ? PROXY_URL : GOOGLE;
  const headers = new Headers(init.headers);
  if (conn.kind === 'proxy') headers.set('X-Family-Code', conn.code);
  else headers.set('x-goog-api-key', conn.key);
  if (init.body) headers.set('Content-Type', 'application/json');

  // A model that doesn't answer in time is treated like an overloaded one (try the next).
  const abort = new AbortController();
  const timer = timeoutMs ? setTimeout(() => abort.abort(), timeoutMs) : 0;
  cancel?.addEventListener('abort', () => abort.abort());
  let res: Response;
  try {
    res = await fetch(`${base}/v1beta/${path}`, { ...init, headers, signal: abort.signal });
  } catch {
    if (cancel?.aborted) throw new GeminiError('cancelled', 'http', 0);
    if (abort.signal.aborted) throw new GeminiError('timed out', 'rate-limit', 0, 0);
    throw new GeminiError('network error', 'network');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg: string = body?.error?.message ?? res.statusText;
    const details: { retryDelay?: string; violations?: { quotaId?: string }[] }[] = body?.error?.details ?? [];
    const retry = details.find((d) => d.retryDelay)?.retryDelay;
    const daily = details.some((d) => d.violations?.some((v) => v.quotaId?.includes('PerDay')));
    // Overloaded models (503 "high demand") get a short default wait.
    const retryAfterMs = retry ? Math.ceil(parseFloat(retry) * 1000) : res.status >= 500 ? 5000 : undefined;
    throw new GeminiError(msg, errorKind(conn, res.status, body?.error?.code, msg), res.status, retryAfterMs, daily);
  }
  return res.json();
}

function errorKind(conn: Conn, status: number, code: unknown, msg: string): GeminiErrorKind {
  // 429 (quota) and 500/503 (temporarily overloaded) are both "try another model or wait".
  if (status === 429 || status === 500 || status === 503) return 'rate-limit';
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

/**
 * Models for conversation, best first: the fast model, then other full Flash versions, then Lite. On the free tier each has its own small daily allowance, so a long
 * chat can move down the list instead of stopping.
 */
export function chatModels(choice: ModelChoice | null): string[] {
  if (!choice) return [];
  // Pro is left out: conversation needs quick replies, and the spec allows Flash when Pro is slow.
  const extra = ['gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash'];
  const list = [choice.lookup, ...extra.filter((m) => choice.available.includes(m)), ...lookupModels(choice).slice(1)];
  return [...new Set(list.filter((m): m is string => !!m))];
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
  /** Extra parts for the newest user turn, e.g. a voice recording ({ inlineData: { mimeType, data } }). */
  promptParts?: object[];
  /** Earlier turns of a conversation, sent before `prompt` (which is the newest user turn). */
  history?: { role: 'user' | 'model'; text: string }[];
  schema: object; // Gemini responseSchema (OpenAPI subset)
  temperature?: number;
  /** "low" skips most hidden reasoning: ~3 s instead of ~4+ s for dictionary-style answers. */
  thinkingLevel?: 'low' | 'high';
  /** Called when every model is rate-limited and we're waiting to retry. */
  onWait?: (ms: number) => void;
  /** Give up on a model after this long and try the next (default 30 s). */
  timeoutMs?: number;
}

const MAX_RETRY_WAIT_MS = 30_000;

// Models that just failed are tried last for a while, so later requests skip the detour:
// overloaded / timed out → 2 minutes; free daily allowance used up → 6 hours.
const COOL_KEY = 'wordly.modelCooldowns';
const coolUntil = new Map<string, number>(loadCooldowns());

// Kept on the device so a new chat (or a restart) doesn't rediscover failing models.
function loadCooldowns(): [string, number][] {
  try {
    const now = Date.now();
    return Object.entries(JSON.parse(localStorage.getItem(COOL_KEY) ?? '{}') as Record<string, number>).filter(([, t]) => t > now);
  } catch {
    return [];
  }
}
const OVERLOAD_COOLDOWN_MS = 2 * 60_000;
const DAILY_COOLDOWN_MS = 6 * 60 * 60_000;

export function coolDown(model: string, e: GeminiError): void {
  const ms = e.daily ? DAILY_COOLDOWN_MS : e.status === 429 ? Math.max(e.retryAfterMs ?? 60_000, 10_000) : OVERLOAD_COOLDOWN_MS;
  coolUntil.set(model, Date.now() + ms);
  try {
    localStorage.setItem(COOL_KEY, JSON.stringify(Object.fromEntries(coolUntil)));
  } catch {
    // Storage blocked: cooldowns just last for this session.
  }
}

/** Healthy models first (keeping their order), recently failed ones after. */
export function byHealth(models: string[]): string[] {
  const now = Date.now();
  const ok = models.filter((m) => (coolUntil.get(m) ?? 0) <= now);
  return [...ok, ...models.filter((m) => !ok.includes(m))];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * generateContent with structured JSON output. The free tier allows ~5 requests per minute
 * per model, so a 429 moves on to the next model, and if all are busy we wait once for
 * the delay Google suggests.
 */
export async function generateJSON<T>(conn: Conn, req: JsonRequest): Promise<{ data: T; model: string }> {
  const models = byHealth([...new Set(req.models.filter(Boolean))]);
  let waited = false;
  for (;;) {
    let shortestWait = Infinity;
    for (const model of models) {
      try {
        return { data: await generateOnce<T>(conn, model, req), model };
      } catch (e) {
        // A model this key can't use (e.g. retired, or not on the free tier): try the next one.
        if (e instanceof GeminiError && e.status === 404 && model !== models[models.length - 1]) continue;
        if (!(e instanceof GeminiError) || e.kind !== 'rate-limit') throw e;
        coolDown(model, e);
        shortestWait = Math.min(shortestWait, e.retryAfterMs ?? 60_000);
        if (model === models[models.length - 1] && (waited || shortestWait > MAX_RETRY_WAIT_MS)) throw e;
      }
    }
    waited = true;
    req.onWait?.(shortestWait);
    await sleep(shortestWait + 500);
  }
}

/**
 * Like generateJSON, but for interactive use (conversation): if the current model hasn't answered
 * within `hedgeMs`, the next model is started in parallel and the first good answer wins (the
 * other request is cancelled). A failing model starts the next one immediately.
 */
export async function generateJSONFast<T>(conn: Conn, req: JsonRequest, hedgeMs = 3500): Promise<{ data: T; model: string }> {
  const models = byHealth([...new Set(req.models.filter(Boolean))]);
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    let next = 0;
    let running = 0;
    let settled = false;
    let lastError: unknown = null;
    let hedge: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (hedge) clearTimeout(hedge);
      controllers.forEach((c) => c.abort());
      fn();
    };

    const launch = () => {
      if (settled || next >= models.length) {
        if (!running && !settled) {
          // Everything failed fast: fall back to the patient path (waits for rate limits).
          generateJSON<T>(conn, req).then((r) => finish(() => resolve(r)), (e) => finish(() => reject(lastError ?? e)));
        }
        return;
      }
      const model = models[next++];
      const ctl = new AbortController();
      controllers.push(ctl);
      running++;
      if (hedge) clearTimeout(hedge);
      hedge = setTimeout(launch, hedgeMs);
      generateOnce<T>(conn, model, req, true, ctl.signal).then(
        (data) => finish(() => resolve({ data, model })),
        (e) => {
          running--;
          if (settled) return;
          lastError = e;
          // Errors every model would hit (wrong code, bad key, offline) end the turn; anything
          // else (overloaded, quota, timeout, unreadable answer) moves on to the next model.
          const fatal = !(e instanceof GeminiError) || ['bad-code', 'invalid-key', 'proxy-config', 'network'].includes(e.kind);
          if (fatal) return finish(() => reject(e));
          if (e.kind === 'rate-limit') coolDown(model, e);
          launch();
        },
      );
    };
    launch();
  });
}

async function generateOnce<T>(conn: Conn, model: string, req: JsonRequest, withThinking = true, cancel?: AbortSignal): Promise<T> {
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [
      ...(req.history ?? []).map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      { role: 'user', parts: [...(req.promptParts ?? []), { text: req.prompt }] },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: req.schema,
      temperature: req.temperature ?? 0.4,
      ...(req.thinkingLevel && withThinking ? { thinkingConfig: { thinkingLevel: req.thinkingLevel } } : {}),
    },
  };
  let res: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] };
  try {
    res = await request(conn, `models/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body) }, req.timeoutMs ?? 30_000, cancel);
  } catch (e) {
    // Some models don't accept thinking settings; ask again without them.
    if (withThinking && req.thinkingLevel && e instanceof GeminiError && e.status === 400 && /think/i.test(e.message)) {
      return generateOnce<T>(conn, model, req, false, cancel);
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
