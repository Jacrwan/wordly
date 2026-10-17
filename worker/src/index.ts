// Wordly Gemini proxy.
//
// The app (a static site) can't hold the Gemini key, so it calls this Worker instead.
// The Worker checks the family code, adds the key, and forwards only the Gemini
// endpoints the app uses. Responses (including streams and audio) pass through as-is.

const UPSTREAM = 'https://generativelanguage.googleapis.com';
const MAX_BODY_BYTES = 6_000_000; // room for voice recordings (≈1.3 MB per 30 s)

// GET  /v1beta/models                       list models
// GET  /v1beta/models/{id}                  model info
// POST /v1beta/models/{id}:{method}         generate / stream / count tokens
const ROUTES: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/v1beta\/models$/ },
  { method: 'GET', pattern: /^\/v1beta\/models\/[\w.-]+$/ },
  { method: 'POST', pattern: /^\/v1beta\/models\/[\w.-]+:(generateContent|streamGenerateContent|countTokens)$/ },
];

interface Env {
  GEMINI_API_KEY: string;
  FAMILY_CODE: string;
  ALLOWED_ORIGINS: string;
  FAIL_LIMITER?: RateLimit;
  USE_LIMITER?: RateLimit;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    const cors = corsHeaders(origin && allowed.includes(origin) ? origin : null);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return error(403, 'ORIGIN', 'Origin not allowed', cors);

    const url = new URL(request.url);
    if (!ROUTES.some((r) => r.method === request.method && r.pattern.test(url.pathname))) {
      return error(404, 'ROUTE', 'Not found', cors);
    }

    if (!env.GEMINI_API_KEY || !env.FAMILY_CODE) {
      return error(500, 'CONFIG', 'Proxy secrets are not set', cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const code = request.headers.get('X-Family-Code') ?? '';
    // Case and surrounding spaces don't matter: "Sunflower " works for "sunflower".
    if (!(await sameSecret(normalizeCode(code), normalizeCode(env.FAMILY_CODE)))) {
      const limited = env.FAIL_LIMITER && !(await env.FAIL_LIMITER.limit({ key: `fail:${ip}` })).success;
      return limited
        ? error(429, 'RATE_LIMIT', 'Too many attempts. Try again in a minute.', cors)
        : error(401, 'FAMILY_CODE', 'Wrong family code', cors);
    }

    if (env.USE_LIMITER && !(await env.USE_LIMITER.limit({ key: 'family' })).success) {
      return error(429, 'RATE_LIMIT', 'Too many requests. Try again in a minute.', cors);
    }

    let body: ArrayBuffer | undefined;
    if (request.method === 'POST') {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return error(413, 'TOO_LARGE', 'Request too large', cors);
    }

    // Pass the query through (e.g. alt=sse, pageSize) but never a caller-supplied key.
    url.searchParams.delete('key');
    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: request.method,
      headers: {
        'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body,
    });

    const headers = new Headers(cors);
    const type = upstream.headers.get('Content-Type');
    if (type) headers.set('Content-Type', type);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
} satisfies ExportedHandler<Env>;

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Family-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function error(status: number, code: string, message: string, cors: Record<string, string>): Response {
  return Response.json({ error: { code, message, status } }, { status, headers: cors });
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

// Constant-time comparison; hashing first makes both sides the same length.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
