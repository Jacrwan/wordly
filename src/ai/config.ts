// Public address of the family Gemini proxy (worker/). Not a secret: the proxy
// refuses requests without the family code. Override locally with VITE_PROXY_URL.
export const PROXY_URL: string = import.meta.env.VITE_PROXY_URL ?? 'https://wordly-proxy.REPLACE_ME.workers.dev';
