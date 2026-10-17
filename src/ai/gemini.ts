import type { ModelChoice } from '../db/schema';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  readonly kind: 'invalid-key' | 'network' | 'http';
  readonly status?: number;

  constructor(message: string, kind: GeminiError['kind'], status?: number) {
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

async function request<T>(apiKey: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}`, { headers: { 'x-goog-api-key': apiKey } });
  } catch {
    throw new GeminiError('network error', 'network');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg: string = body?.error?.message ?? res.statusText;
    const invalid = res.status === 400 || res.status === 401 || res.status === 403;
    throw new GeminiError(msg, invalid && /key/i.test(msg) ? 'invalid-key' : 'http', res.status);
  }
  return res.json();
}

export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let pageToken = '';
  do {
    const q = `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const page = await request<{
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    }>(apiKey, q);
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
