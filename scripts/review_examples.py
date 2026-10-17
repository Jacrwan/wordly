"""Have Gemini review OpenSubtitles example candidates for the most frequent words.

For each word Gemini orders the Korean meanings by everyday use (using subtitle counts as
evidence), picks the 2-3 candidate sentence pairs that are correctly translated, natural and
family-friendly, and writes new examples only when too few candidates pass (marked AI).

Results are appended to --out (JSON lines), so the run can stop and resume at any time.
Auth: GEMINI_API_KEY (direct), or the family code for the Wordly proxy (WORDLY_FAMILY_CODE,
or typed at the prompt; it is never printed or saved).

Usage:
  python -I scripts/review_examples.py --dict public/data/dict --subs data-raw/cache/subs-v1.pickle.gz \\
      --out data-raw/cache/review-v1.jsonl --limit 10000
  ... --words apply,run,get        # review just these (pilot)
"""

from __future__ import annotations

import argparse
import getpass
import gzip
import json
import os
import pickle
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import certifi

# python.org builds on macOS ship without CA certificates; use certifi's bundle.
SSL = ssl.create_default_context(cafile=certifi.where())

PROXY = 'https://wordly-proxy.jacrwan.workers.dev'
GOOGLE = 'https://generativelanguage.googleapis.com'
# Full Flash models only, newest first. Flash-Lite accepted noticeably worse candidates.
# On the free tier each model has its own small daily allowance, so the run moves down
# this list as models run out, and picks up again the next day.
DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
                  'gemini-3-flash-preview']
RPM_PER_MODEL = 5  # free tier
MAX_CANDIDATES = 10
# Subtitle lines that make poor dictionary examples: fragments, stutters, filler openers, oaths.
FRAGMENT = re.compile(r"^(and|but|so|or|oh|well|yeah|yes|no|okay|ok|now|then|because|like|um|uh)\b", re.I)
STUTTER = re.compile(r"\b(\w)-\1|\b(\w+),? \2\b", re.I)
OATHS = re.compile(r"\b(hell|god|jesus|christ|lord|heaven|devil)\b", re.I)
HANGUL = re.compile(r'[가-힣]')

SYSTEM = """You are a careful lexicographer building an English–Korean learner's dictionary for Korean adults, including seniors.
For each word you get: its parts of speech and English senses, Korean meanings from the dictionary (dictionary order, not frequency order), how often each Korean meaning appeared in real movie/TV subtitle translations, and candidate English–Korean sentence pairs taken from subtitles.

For each word return:
1. meanings: the 1–4 Korean meanings an adult learner most needs, MOST USEFUL IN EVERYDAY ADULT LIFE FIRST (work, shopping, banking, health, housing, travel, family). Subtitle counts are only a hint: they over-represent action and crime movie language (e.g. bill → 계산서 before 법안; charge → 요금 before 돌격; show → 보여주다 first). Prefer the dictionary's Korean wording; add a missing very common meaning if needed (e.g. fine → 괜찮다). Use dictionary form (verbs end in -다), no explanations, no hanja.
2. examples: the IDs of 2–3 candidates that ALL of these are true for:
   - the Korean translation means the same as the English (reject loose, partial or wrong translations),
   - the word is used in one of your meanings,
   - a natural, everyday sentence that makes sense on its own without the movie's context (reject fragments, stutters, typos, odd grammar),
   - suitable for a family learning app (no violence, crime, sexual content, insults, religion or politics).
   Be strict. Reject a candidate if the Korean is ungrammatical, looks machine-translated (e.g. dictionary-form verbs like "보도되다." or word-for-word phrasing), adds or drops meaning, or if the English is unclear without context (e.g. "I need to know the who and the where."). When in doubt, reject it and write your own example instead.
   Prefer examples that show different meanings, and simpler sentences. Give the meaning each example shows (copy one of your meanings). Never edit candidate text.
3. new_examples: ONLY if fewer than 2 candidates qualify, write new short everyday examples (max 12 words) so the total is 2–3. The Korean must be what a native speaker would naturally say, in polite spoken style (해요체), translating the meaning rather than word for word (e.g. "I feel much better today." → "오늘은 훨씬 나아요."). Otherwise return an empty list.
Return one result per input word, with the same id."""

SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'results': {
            'type': 'ARRAY',
            'items': {
                'type': 'OBJECT',
                'properties': {
                    'id': {'type': 'STRING'},
                    'meanings': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
                    'examples': {
                        'type': 'ARRAY',
                        'items': {
                            'type': 'OBJECT',
                            'properties': {'id': {'type': 'STRING'}, 'meaning': {'type': 'STRING'}},
                            'required': ['id', 'meaning'],
                            'propertyOrdering': ['id', 'meaning'],
                        },
                    },
                    'new_examples': {
                        'type': 'ARRAY',
                        'items': {
                            'type': 'OBJECT',
                            'properties': {'en': {'type': 'STRING'}, 'ko': {'type': 'STRING'}, 'meaning': {'type': 'STRING'}},
                            'required': ['en', 'ko', 'meaning'],
                            'propertyOrdering': ['en', 'ko', 'meaning'],
                        },
                    },
                },
                'required': ['id', 'meanings', 'examples', 'new_examples'],
                'propertyOrdering': ['id', 'meanings', 'examples', 'new_examples'],
            },
        },
    },
    'required': ['results'],
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- Gemini over HTTP (stdlib only)

class RateLimited(Exception):
    def __init__(self, retry_s: float, daily: bool, limit: str = ''):
        super().__init__(f'rate limited (retry {retry_s:.0f}s, daily={daily})')
        self.retry_s, self.daily, self.limit = retry_s, daily, limit


class Unavailable(Exception):
    """The model is listed but can't be used (e.g. retired for new users)."""


class Client:
    def __init__(self):
        key = os.environ.get('GEMINI_API_KEY')
        if key:
            self.base, self.headers = GOOGLE, {'x-goog-api-key': key}
        else:
            code = os.environ.get('WORDLY_FAMILY_CODE') or getpass.getpass('Wordly family code (hidden): ')
            self.base, self.headers = PROXY, {'X-Family-Code': code.strip()}

    def call(self, method: str, path: str, body: dict | None = None, timeout=180) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f'{self.base}/v1beta/{path}', data=data, method=method,
                                     headers={**self.headers, 'Content-Type': 'application/json',
                                              # Cloudflare blocks Python's default user agent (error 1010).
                                              'User-Agent': 'Wordly-build/0.1 (+https://github.com/Jacrwan/wordly)'})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            err = json.loads(e.read() or b'{}').get('error', {})
            if e.code == 429:
                details = err.get('details', [])
                retry = next((d.get('retryDelay') for d in details if d.get('retryDelay')), '60s')
                violations = [v for d in details for v in d.get('violations', [])]
                daily = [v for v in violations if 'PerDay' in v.get('quotaId', '')]
                raise RateLimited(float(retry.rstrip('s') or 60), bool(daily), daily[0].get('quotaValue', '') if daily else '')
            if e.code == 401 and err.get('code') == 'FAMILY_CODE':
                sys.exit('Wrong family code.')
            if e.code == 404:
                raise Unavailable(err.get('message', '')[:200])
            raise RuntimeError(f'HTTP {e.code}: {err.get("message", "")[:300]}')

    def models(self) -> list[str]:
        out, token = [], ''
        while True:
            page = self.call('GET', f'models?pageSize=1000' + (f'&pageToken={token}' if token else ''))
            out += [m['name'].removeprefix('models/') for m in page.get('models', [])
                    if 'generateContent' in m.get('supportedGenerationMethods', [])]
            token = page.get('nextPageToken')
            if not token:
                return out

    def generate(self, model: str, prompt: str) -> dict:
        body = {
            'systemInstruction': {'parts': [{'text': SYSTEM}]},
            'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
            'generationConfig': {
                'responseMimeType': 'application/json',
                'responseSchema': SCHEMA,
                'temperature': 0.1,
            },
        }
        try:
            res = self.call('POST', f'models/{model}:generateContent', body)
        except RuntimeError as e:
            if 'think' not in str(e).lower():
                raise
            del body['generationConfig']['thinkingConfig']
            res = self.call('POST', f'models/{model}:generateContent', body)
        parts = res.get('candidates', [{}])[0].get('content', {}).get('parts', [])
        return json.loads(''.join(p.get('text', '') for p in parts if not p.get('thought')))


class Limiter:
    """At most RPM_PER_MODEL requests per rolling minute per model; skips models out for the day."""

    def __init__(self, models: list[str]):
        self.models = models
        self.sent = {m: deque() for m in models}
        self.blocked_until = {m: 0.0 for m in models}
        self.daily_out: set[str] = set()
        self.lock = threading.Lock()

    def acquire(self) -> str:
        while True:
            with self.lock:
                live = [m for m in self.models if m not in self.daily_out]
                if not live:
                    raise SystemExit('Daily free quota used up on all models. Run `npm run review` again tomorrow '
                                     '(quotas reset at midnight US Pacific time, about 4–5 pm in Korea).')
                now = time.time()
                for m in live:
                    q = self.sent[m]
                    while q and now - q[0] > 60:
                        q.popleft()
                    if len(q) < RPM_PER_MODEL and now >= self.blocked_until[m]:
                        q.append(now)
                        return m
            time.sleep(1)

    def drop(self, model: str, reason: str):
        with self.lock:
            if model not in self.daily_out:
                self.daily_out.add(model)
                log(f'  {model}: not usable ({reason[:80]}); skipping it')

    def limited(self, model: str, e: RateLimited):
        with self.lock:
            if e.daily:
                if model not in self.daily_out:
                    log(f'  {model}: daily quota used up' + (f' (limit {e.limit} requests/day)' if e.limit else '') +
                        (f'; continuing with {", ".join(m for m in self.models if m not in self.daily_out and m != model)}'
                         if len(self.daily_out) + 1 < len(self.models) else ''))
                self.daily_out.add(model)
            else:
                self.blocked_until[model] = time.time() + e.retry_s + 1


# ---------------------------------------------------------------- batches

def load_dict(dict_dir: Path) -> tuple[dict[str, dict], dict[str, set[str]]]:
    entries = {}
    for f in sorted(dict_dir.glob('*.json')):
        entries.update(json.loads(f.read_text(encoding='utf-8'))['e'])
    irregular: dict[str, set[str]] = {}
    for k, e in entries.items():
        if 'to' in e:
            irregular.setdefault(e['to'].lower(), set()).add(k)
    return {k: e for k, e in entries.items() if 'to' not in e}, irregular


def word_forms(key: str, irregular: dict[str, set[str]]) -> set[str]:
    """Spellings an example may use for the word: listed inflections plus regular endings."""
    head, _, rest = key.partition(' ')
    stems = {head} | irregular.get(head, set())
    out = set()
    for w in stems:
        out |= {w, w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing', w + 'er', w + 'est', w + 'ly'}
        if w.endswith('e'):
            out |= {w[:-1] + 'ing', w[:-1] + 'ed'}
        if w.endswith('y'):
            out |= {w[:-1] + 'ies', w[:-1] + 'ied', w[:-1] + 'ily'}
        if len(w) > 2 and w[-1] not in 'aeiouwy':
            out |= {w + w[-1] + 'ed', w + w[-1] + 'ing'}
    return {f'{f} {rest}' if rest else f for f in out}


def mentions(sentence: str, forms: set[str]) -> bool:
    text = ' ' + re.sub(r"[^a-z' ]", ' ', sentence.lower().replace('’', "'")) + ' '
    return any(f' {f} ' in text or f" {f}'" in text for f in forms)


def dict_meanings(e: dict) -> list[str]:
    out = []
    for b in e['pos']:
        for s in b['s']:
            out += s.get('ko', [])
    out += e.get('ko', []) + e.get('ofKo', [])
    return list(dict.fromkeys(out))


def pick_candidates(cands: list, counts: dict) -> list[tuple[str, str]]:
    """Up to MAX_CANDIDATES pairs, spread across meanings (most frequent meaning first)."""
    buckets: dict[str, list] = {}
    for score, en, ko, bucket in cands:
        buckets.setdefault(bucket, []).append((en, ko))
    order = sorted((b for b in buckets if b != '*'), key=lambda b: -counts.get(b, 0)) + (['*'] if '*' in buckets else [])
    for b in buckets:
        buckets[b] = [(en, ko) for en, ko in buckets[b] if not (FRAGMENT.match(en) or STUTTER.search(en) or OATHS.search(en))]
    picked, seen = [], set()
    for round_ in range(4):
        for b in order:
            if len(buckets[b]) > round_ and len(picked) < MAX_CANDIDATES:
                pair = buckets[b][round_]
                if pair[0].lower() not in seen:
                    seen.add(pair[0].lower())
                    picked.append(pair)
    return picked


def build_item(key: str, e: dict, subs: dict) -> dict:
    counts = subs['counts'].get(key, {})
    cands = pick_candidates(subs['cands'].get(key, []), counts)
    return {
        'word': e['w'],
        'pos': list(dict.fromkeys(b['p'] for b in e['pos'])),
        'senses': [s['g'][:100] for b in e['pos'] for s in b['s']][:5],
        'dict_meanings': dict_meanings(e)[:8],
        'subtitle_counts': dict(list(counts.items())[:6]),
        'candidates': [{'id': f'c{i + 1}', 'en': en, 'ko': ko} for i, (en, ko) in enumerate(cands)],
    }


def validate(key: str, item: dict, r: dict, forms: set[str]) -> dict | None:
    meanings = [m.strip() for m in r.get('meanings', []) if isinstance(m, str) and HANGUL.search(m)][:4]
    if not meanings:
        return None
    by_id = {c['id']: c for c in item['candidates']}
    examples = []
    for x in r.get('examples', []):
        c = by_id.get(x.get('id'))
        if c and mentions(c['en'], forms) and not any(ex['e'] == c['en'] for ex in examples):
            examples.append({'e': c['en'], 'k': c['ko'], 'm': x.get('meaning', '').strip()})
    for x in r.get('new_examples', []):
        if len(examples) >= 3:
            break
        if x.get('en') and x.get('ko') and HANGUL.search(x['ko']) and mentions(x['en'], forms):
            examples.append({'e': x['en'].strip(), 'k': x['ko'].strip(), 'm': x.get('meaning', '').strip(), 'a': 1})
    return {'key': key, 'meanings': meanings, 'examples': examples[:3]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dict', type=Path, required=True)
    ap.add_argument('--subs', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--limit', type=int, default=10_000, help='review the N most frequent entries')
    ap.add_argument('--words', help='comma-separated keys to review instead (pilot)')
    ap.add_argument('--batch', type=int, default=40)
    ap.add_argument('--parallel', type=int, default=2, help='concurrent requests per model')
    ap.add_argument('--then-limit', type=int, help='after the --words pilot, pause, then review the top N words')
    ap.add_argument('--models', default=','.join(DEFAULT_MODELS), help='comma-separated models to use, in order')
    ap.add_argument('--redo-model', help='first drop earlier results from this model so they are reviewed again')
    args = ap.parse_args()

    entries, irregular = load_dict(args.dict)
    args.irregular = irregular
    with gzip.open(args.subs, 'rb') as f:
        subs = pickle.load(f)
    if args.redo_model and args.out.exists():
        lines = args.out.read_text(encoding='utf-8').splitlines()
        keep = [l for l in lines if l.strip() and json.loads(l).get('model') != args.redo_model]
        args.out.write_text(''.join(l + '\n' for l in keep), encoding='utf-8')
        log(f'dropped {len(lines) - len(keep):,} results from {args.redo_model}; they will be reviewed again')
    client = None
    phases = [args.words, None] if args.words and args.then_limit else [args.words]
    for phase, words in enumerate(phases):
        if phase:
            args.limit = args.then_limit
            input(f'\nPilot done. Press Return to review the top {args.limit:,} words (Ctrl-C to stop)... ')
        client = review(args, entries, subs, words, client)


def review(args, entries, subs, words, client):
    done = set()
    if args.out.exists():
        done = {json.loads(l)['key'] for l in args.out.read_text(encoding='utf-8').splitlines() if l.strip()}

    if words:
        keys = [w.strip().lower() for w in words.split(',') if w.strip().lower() in entries]
    else:
        # Affixes and numbers ("-s", "were-", "3") aren't worth teaching examples for.
        real_words = [k for k in entries if re.search(r'[a-z]', k) and not k.startswith(('-', "'")) and not k.endswith('-')]
        keys = sorted(real_words, key=lambda k: (entries[k]['r'], k))[:args.limit]
    todo = [k for k in keys if k not in done]
    log(f'{len(keys):,} words selected, {len(keys) - len(todo):,} already reviewed, {len(todo):,} to go')
    if not todo:
        return client

    client = client or Client()
    available = client.models()
    wanted = [m.strip() for m in args.models.split(',') if m.strip()]
    models = [m for m in wanted if m in available] or [m for m in available if 'flash' in m][:1]
    log(f'models: {", ".join(models)}')
    limiter = Limiter(models)

    batches = [todo[i:i + args.batch] for i in range(0, len(todo), args.batch)]
    write_lock = threading.Lock()
    t0 = time.time()
    progress = {'words': 0, 'batches': 0, 'failed': 0}

    def run(batch: list[str]):
        items = {f'w{i + 1}': (k, build_item(k, entries[k], subs)) for i, k in enumerate(batch)}
        prompt = json.dumps([{'id': i, **it} for i, (_, it) in items.items()], ensure_ascii=False)
        for attempt in range(6):
            model = limiter.acquire()
            try:
                data = client.generate(model, prompt)
                break
            except RateLimited as e:
                limiter.limited(model, e)
            except Unavailable as e:
                limiter.drop(model, str(e))
            except (RuntimeError, json.JSONDecodeError, urllib.error.URLError, TimeoutError) as e:
                log(f'  {model}: {str(e)[:160]} (retry {attempt + 1})')
                time.sleep(5)
        else:
            with write_lock:
                progress['failed'] += len(batch)
            return
        results = {r.get('id'): r for r in data.get('results', [])}
        lines = []
        for i, (key, item) in items.items():
            v = results.get(i) and validate(key, item, results[i], word_forms(key, args.irregular))
            if v:
                v['model'] = model
                lines.append(json.dumps(v, ensure_ascii=False))
        with write_lock:
            with open(args.out, 'a', encoding='utf-8') as f:
                f.write(''.join(l + '\n' for l in lines))
            progress['words'] += len(lines)
            progress['failed'] += len(batch) - len(lines)
            progress['batches'] += 1
            rate = progress['words'] / max(1, time.time() - t0)
            left = len(todo) - progress['words'] - progress['failed']
            skipped = f', {progress["failed"]} skipped' if progress['failed'] else ''
            eta = f', ~{left / rate / 60:.0f} min left' if rate else ''
            log(f'  batch {progress["batches"]}/{len(batches)}: {progress["words"]:,} words reviewed{skipped}{eta}')

    pool = ThreadPoolExecutor(max_workers=args.parallel * len(models))
    try:
        for fut in as_completed([pool.submit(run, b) for b in batches]):
            fut.result()
    except (KeyboardInterrupt, SystemExit):
        # Ctrl-C or quota exhaustion: drop queued batches instead of letting worker threads continue.
        pool.shutdown(wait=False, cancel_futures=True)
        log('stopped; finished batches are saved and the rest will be reviewed on the next run')
        os._exit(0)
    pool.shutdown()
    log(f'finished in {(time.time() - t0) / 60:.0f} min: {progress["words"]:,} reviewed, {progress["failed"]:,} skipped '
        '(skipped words are retried on the next run)')
    return client


if __name__ == '__main__':
    main()
