"""Build Wordly's offline dictionary.

Sources:
  - English Wiktionary via kaikki.org (wiktextract JSONL)   CC BY-SA 4.0 (downloaded into --raw if missing)
  - wordfreq frequency ranks                                 CC BY-SA 4.0
  - Optional, from OpenSubtitles (OPUS, opensubtitles.org):
      --subs    meaning counts from scripts/mine_subtitles.py (orders Korean meanings by real usage)
      --review  Gemini-reviewed meanings and example pairs from scripts/review_examples.py

Output (--out, normally public/data):
  dict/{shard}.json   English entries sharded by the first two letters ("ap", "a_", "e_")
  ko/{nn}.json        Korean -> English index sharded by the first syllable's initial consonant
  manifest.json       version, shard list, sizes and coverage stats

Usage:
  python -I scripts/build_dict.py --raw data-raw --out public/data \
      --subs data-raw/cache/subs-v1.pickle.gz --review data-raw/cache/review-v1.jsonl
  ... --refresh   # re-extract Wiktionary instead of using the cache
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import hashlib
import json
import pickle
import re
import shutil
import ssl
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

import certifi
from wordfreq import top_n_list, zipf_frequency

KAIKKI_URL = 'https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz'

CORE_WORDS = 30_000  # most frequent words that are always included
FREQ_POOL = 100_000  # wordfreq list used for ranks and candidates
SIZE_BUDGET = 29_000_000  # bytes of JSON across all shards (target: under 30 MB)

MAX_SENSES_PER_POS = 4  # plus later senses that carry a Korean translation...
MAX_SENSES_PER_POS_KO = 8  # ...up to this many
MAX_SENSES = 12
MAX_EXAMPLES = 2
MAX_EXAMPLE_LEN = 140
MAX_GLOSS_LEN = 220
MAX_SYN = 8
MAX_ANT = 5
MAX_KO_PER_SENSE = 4
MAX_KO_INDEX_HITS = 15

DROP_SENSE_TAGS = {
    'obsolete', 'archaic', 'rare', 'dialectal', 'nonstandard', 'misspelling',
    'pronunciation-spelling', 'eye-dialect', 'obsolete-spelling',
}
DROP_WORD_TAGS = {'obsolete', 'archaic', 'rare', 'dialectal'}
HANGUL = re.compile(r'[가-힣]')
COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/'
TOKEN = re.compile(r"[a-z]+(?:['’-][a-z]+)*")
CACHE_NAME = 'extract-v1.pickle.gz'


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- downloads

def download(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f'downloading {url}')
    tmp = dest.with_suffix(dest.suffix + '.part')
    ctx = ssl.create_default_context(cafile=certifi.where())  # macOS python.org builds lack CA certs
    with urllib.request.urlopen(url, context=ctx) as r, open(tmp, 'wb') as f:
        shutil.copyfileobj(r, f, length=1 << 20)
    tmp.rename(dest)


def fetch_sources(raw: Path) -> Path:
    kaikki = raw / 'kaikki' / 'kaikki-English.jsonl.gz'
    download(KAIKKI_URL, kaikki)
    return kaikki


# ---------------------------------------------------------------- pass 1: extract Wiktionary

def has_hangul(s: str) -> bool:
    return bool(HANGUL.search(s))


def clean_ko(word: str) -> str:
    return re.sub(r'\s+', ' ', word).strip()


def word_list(items, limit=None) -> list[str]:
    out = []
    for x in items or []:
        w = x.get('word', '').strip()
        if not w or set(x.get('tags', [])) & DROP_WORD_TAGS:
            continue
        out.append(w)
    return out[:limit] if limit else out


def short_examples(sense) -> list[str]:
    out = []
    for ex in sense.get('examples', []):
        text = (ex.get('text') or '').strip()
        # "example" entries are short usage lines; "quotation" ones are long literary citations.
        if not text or ex.get('type') == 'quotation' or len(text) > MAX_EXAMPLE_LEN:
            continue
        out.append(text)
        if len(out) >= MAX_EXAMPLES:
            break
    return out


def extract_entry(e) -> dict:
    """Keeps only the fields the app uses, in a compact form."""
    senses = []
    for s in e.get('senses', []):
        glosses = s.get('glosses') or s.get('raw_glosses') or []
        ko = [clean_ko(t['word']) for t in s.get('translations', [])
              if t.get('lang_code') == 'ko' and has_hangul(t.get('word', ''))]
        senses.append({
            'g': glosses[-1] if glosses else '',
            'tags': s.get('tags', []),
            'of': [x['word'] for x in (s.get('form_of') or []) + (s.get('alt_of') or []) if x.get('word')],
            'ex': short_examples(s),
            'syn': word_list(s.get('synonyms')),
            'ant': word_list(s.get('antonyms')),
            'ko': ko,
        })
    # Word-level translations carry _dis1: a match score for each sense, in sense order.
    top_ko = []
    for t in e.get('translations', []):
        if t.get('lang_code') != 'ko' or not has_hangul(t.get('word', '')):
            continue
        scores = [int(x) for x in (t.get('_dis1') or '').split() if x.isdigit()]
        best = max(range(len(scores)), key=scores.__getitem__) if scores and max(scores) > 0 else -1
        top_ko.append((clean_ko(t['word']), best))
    return {
        'word': e['word'],
        'pos': e.get('pos', ''),
        'ipa': [(s['ipa'], s.get('tags', [])) for s in e.get('sounds', []) if s.get('ipa')],
        'audio': [(s['mp3_url'], s.get('tags', []), s.get('audio', '')) for s in e.get('sounds', []) if s.get('mp3_url')],
        'senses': senses,
        'top_ko': top_ko,
        'syn': word_list(e.get('synonyms')),
        'ant': word_list(e.get('antonyms')),
        'forms': [f['form'] for f in e.get('forms', [])
                  if f.get('form') and not set(f.get('tags', [])) & ({'alternative', 'table-tags', 'inflection-template'} | DROP_WORD_TAGS)],
    }


def extract(kaikki: Path, cache: Path, refresh: bool) -> dict[str, list[dict]]:
    if cache.exists() and not refresh:
        log(f'using cached extract {cache}')
        with gzip.open(cache, 'rb') as f:
            return pickle.load(f)

    pool = set(top_n_list('en', FREQ_POOL))
    by_key: dict[str, list[dict]] = defaultdict(list)
    t0 = time.time()
    n = kept = 0
    with gzip.open(kaikki, 'rt', encoding='utf-8') as f:
        for line in f:
            n += 1
            if n % 200_000 == 0:
                log(f'  {n:,} lines, {kept:,} kept, {time.time() - t0:.0f}s')
            e = json.loads(line)
            if e.get('lang_code') != 'en' or not e.get('word'):
                continue
            key = e['word'].lower()
            ko_anywhere = any(t.get('lang_code') == 'ko' for s in e.get('senses', []) for t in s.get('translations', [])) \
                or any(t.get('lang_code') == 'ko' for t in e.get('translations', []))
            if key not in pool and not ko_anywhere:
                continue
            by_key[key].append(extract_entry(e))
            kept += 1
    log(f'extracted {kept:,} entries for {len(by_key):,} words from {n:,} lines in {time.time() - t0:.0f}s')
    cache.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(cache, 'wb') as f:
        pickle.dump(dict(by_key), f, protocol=pickle.HIGHEST_PROTOCOL)
    return by_key


# ---------------------------------------------------------------- pass 2: build entries

def phonemic(ipas) -> set[str]:
    return {i.strip('/') for i, _ in ipas if i.startswith('/')}


def pick_ipa(ipas) -> str | None:
    us = [i for i, tags in ipas if i.startswith('/') and {'US', 'General-American'} & set(tags)]
    slash = [i for i, _ in ipas if i.startswith('/')]
    return (us or slash or [i for i, _ in ipas] or [None])[0]


def pick_audio(audios) -> str | None:
    def score(a):
        url, tags, name = a
        return (bool({'US', 'General-American'} & set(tags)), name.lower().startswith('en-us-'))
    return max(audios, key=score)[0] if audios else None


def compact_audio(url: str) -> str:
    """Commons transcode URLs follow transcoded/{d}/{dd}/{name}/{name}.mp3; store just "{d}/{dd}/{name}"."""
    m = re.fullmatch(re.escape(COMMONS) + r'transcoded/([0-9a-f]/[0-9a-f]{2})/([^/]+)/\2\.mp3', url)
    return f'{m.group(1)}/{m.group(2)}' if m else url


def trim(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(' ', 1)[0]
    return cut.rstrip(',;:') + '…'


def dedupe(items, limit=None, exclude=()) -> list[str]:
    seen, out = set(exclude), []
    for x in items:
        k = x.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
        if limit and len(out) >= limit:
            break
    return out


def build_entry(key: str, raw_entries: list[dict]) -> dict | None:
    # Lowercase spellings first ("march" before "March"); proper names only if they have Korean.
    entries = sorted(raw_entries, key=lambda e: e['word'] != key)
    pos_blocks, lemmas, word_ko, syn, ant = [], [], [], [], []
    primary = None
    total = 0

    for e in entries:
        is_name = e['pos'] == 'name'
        kept = []  # (original index, sense)
        for i, s in enumerate(e['senses']):
            if s['of'] and ('form-of' in s['tags'] or 'alt-of' in s['tags'] or not s['g']):
                lemmas.extend(s['of'])
                continue
            if s['of'] and re.match(r'^(alternative|obsolete|archaic|misspelling|nonstandard)', s['g'], re.I):
                lemmas.extend(s['of'])
                continue
            if not s['g'] or set(s['tags']) & DROP_SENSE_TAGS:
                continue
            kept.append((i, s))

        # Word-level Korean: attach to the best-scoring sense when that sense survived filtering.
        top_by_sense = defaultdict(list)
        kept_idx = {i for i, _ in kept}
        for ko, best in e['top_ko']:
            (top_by_sense[best] if best in kept_idx else word_ko).append(ko)

        if is_name and not any(s['ko'] or top_by_sense[i] for i, s in kept):
            continue

        chosen = []
        for i, s in kept:
            ko = dedupe(s['ko'] + top_by_sense[i], MAX_KO_PER_SENSE)
            if len(chosen) < MAX_SENSES_PER_POS or (ko and len(chosen) < MAX_SENSES_PER_POS_KO):
                sense = {'g': trim(s['g'], MAX_GLOSS_LEN)}
                if ko:
                    sense['ko'] = ko
                if s['ex']:
                    sense['ex'] = s['ex']
                chosen.append(sense)
            syn.extend(s['syn'])
            ant.extend(s['ant'])
        chosen = chosen[:max(0, MAX_SENSES - total)]
        if not chosen:
            continue
        total += len(chosen)
        if primary is None:
            primary = e
        syn.extend(e['syn'])
        ant.extend(e['ant'])
        # Merge same POS across etymologies (e.g. two "noun" entries).
        block = next((b for b in pos_blocks if b['p'] == e['pos']), None)
        if block:
            block['s'].extend(chosen)
        else:
            pos_blocks.append({'p': e['pos'], 's': chosen})

    lemmas = dedupe([l for l in lemmas if l.lower() != key], 2)
    if primary is None:
        # Only inflections / alternative spellings: store a pointer to the lemma.
        return {'w': entries[0]['word'], 'to': lemmas[0]} if lemmas else None

    entry = {'w': primary['word']}
    main = phonemic(primary['ipa'])
    ipa = pick_ipa(primary['ipa'])
    if ipa:
        entry['ipa'] = ipa
    # Only use recordings from entries pronounced like the main one ("apply" vs. "apply" = appley).
    audios = list(primary['audio'])
    if main:
        for e in entries:
            if e is not primary and phonemic(e['ipa']) & main:
                audios.extend(e['audio'])
    audio = pick_audio(audios)
    if audio:
        entry['au'] = compact_audio(audio)
    entry['pos'] = pos_blocks
    word_ko = dedupe(word_ko, 6, exclude=[k for b in pos_blocks for s in b['s'] for k in s.get('ko', [])])
    if word_ko:
        entry['ko'] = word_ko
    syn = dedupe([s for s in syn if len(s.split()) <= 3], MAX_SYN, exclude=[key])
    ant = dedupe([a for a in ant if len(a.split()) <= 3], MAX_ANT, exclude=[key])
    if syn:
        entry['syn'] = syn
    if ant:
        entry['ant'] = ant
    if lemmas:
        entry['of'] = lemmas
    return entry


def has_korean(entry: dict) -> bool:
    return bool(entry.get('ko')) or any(s.get('ko') for b in entry.get('pos', []) for s in b['s'])


def first_korean(entry: dict, n: int = 3) -> list[str]:
    return dedupe([k for b in entry.get('pos', []) for s in b['s'] for k in s.get('ko', [])] + entry.get('ko', []), n)


def inherit_korean(built: dict[str, dict]) -> int:
    """Inflected forms with meanings of their own ("years", "going") but no Korean borrow the
    base word's Korean as ofKo, shown in the app as e.g. "year의 복수형: 해, 년"."""
    n = 0
    for e in built.values():
        if 'to' in e or has_korean(e) or not e.get('of'):
            continue
        lemma = built.get(e['of'][0].lower())
        if lemma and 'to' not in lemma and has_korean(lemma):
            e['ofKo'] = first_korean(lemma)
            n += 1
    return n


# ---------------------------------------------------------------- OpenSubtitles meanings + reviewed examples

def dict_korean(e: dict) -> list[str]:
    return dedupe([k for b in e.get('pos', []) for s in b['s'] for k in s.get('ko', [])] + e.get('ko', []))


def load_review(path: Path | None) -> dict[str, dict]:
    if not path or not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            r = json.loads(line)
            out[r['key']] = r
    return out


def apply_usage(final: dict[str, dict], counts: dict[str, dict], review: dict[str, dict]) -> tuple[int, int]:
    """Adds `top` (Korean meanings, most used first) and `eg` (reviewed example pairs).

    Reviewed words get Gemini's ordering (which can add a missing common meaning, listed in
    `topAi`) and its vetted examples; other words are ordered by subtitle counts alone.
    """
    reviewed = ordered = 0
    for k, e in final.items():
        if 'to' in e:
            continue
        known = dict_korean(e)
        r = review.get(k)
        if r:
            e['top'] = r['meanings']
            new = [m for m in r['meanings'] if m not in known]
            if new:
                e['topAi'] = new
            if r['examples']:
                e['eg'] = [{key: x[key] for key in ('e', 'k', 'm', 'a') if x.get(key)} for x in r['examples']]
            reviewed += 1
            continue
        c = counts.get(k, {})
        used = [m for m in sorted(c, key=lambda m: -c[m]) if c[m] >= 3 and m in known]
        if used:
            e['top'] = (used + [m for m in known if m not in used])[:4]
            ordered += 1
    return reviewed, ordered


# ---------------------------------------------------------------- Korean index

def ko_keys(ko: str) -> set[str]:
    base = re.sub(r'\([^)]*\)|\[[^\]]*\]|[~·…]', '', ko)
    base = re.sub(r'\s+', ' ', base).strip()
    keys = set()
    if has_hangul(base):
        keys.add(base)
        compact = base.replace(' ', '')
        keys.add(compact)
        for suffix in ('하다', '되다', '시키다'):
            if compact.endswith(suffix) and len(compact) > len(suffix) + 1:
                keys.add(compact[:-len(suffix)])
    return keys


def ko_shard(key: str) -> str:
    c = ord(key[0])
    return f'{(c - 0xAC00) // 588:02d}' if 0xAC00 <= c <= 0xD7A3 else 'xx'


def build_ko_index(entries: dict[str, dict]) -> dict[str, dict[str, list[str]]]:
    index: dict[str, dict[str, tuple[int, int]]] = defaultdict(dict)
    for key, e in entries.items():
        if 'to' in e:
            continue
        top = e.get('top', [])
        kos = top + list(e.get('ko', [])) + [k for b in e['pos'] for s in b['s'] for k in s.get('ko', [])]
        for ko in kos:
            # Words where this is a main meaning come first (지원 -> apply, support), then by frequency.
            main = 0 if ko in top[:2] else 1
            for k in ko_keys(ko):
                index[k][key] = min(index[k].get(key, (2, 10**9)), (main, e['r']))
    shards: dict[str, dict[str, list[str]]] = defaultdict(dict)
    for k, words in index.items():
        ranked = sorted(words, key=lambda w: (words[w], w))[:MAX_KO_INDEX_HITS]
        shards[ko_shard(k)][k] = ranked
    return {s: dict(sorted(d.items())) for s, d in sorted(shards.items())}


# ---------------------------------------------------------------- output

def shard_id(key: str) -> str:
    return ''.join(c if 'a' <= c <= 'z' else '_' for c in (key + '_')[:2])


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def entry_size(e) -> int:
    return len(dumps(e).encode()) + 8


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--refresh', action='store_true', help='re-extract Wiktionary instead of using the cache')
    ap.add_argument('--subs', type=Path, help='meaning counts from scripts/mine_subtitles.py')
    ap.add_argument('--review', type=Path, help='reviewed examples from scripts/review_examples.py')
    args = ap.parse_args()

    kaikki = fetch_sources(args.raw)
    by_key = extract(kaikki, args.raw / 'cache' / CACHE_NAME, args.refresh)

    # Ranks: wordfreq list position; phrases and rarer words are placed by their zipf frequency.
    top = top_n_list('en', FREQ_POOL)
    rank_of = {w: i + 1 for i, w in enumerate(top)}
    neg_zipf = [-zipf_frequency(w, 'en') for w in top]

    def word_rank(w: str) -> int:
        if w in rank_of:
            return rank_of[w]
        return bisect.bisect_right(neg_zipf, -zipf_frequency(w, 'en')) + 1

    def rank(key: str) -> int:
        if key in rank_of:
            return rank_of[key]
        parts = TOKEN.findall(key)
        if len(parts) > 1:
            # wordfreq overrates phrases ("is that so" ~ rank 58). A phrase is placed after its
            # rarest word: "is that so" ~1,100 (beginner), "look forward to" ~4,600 (intermediate).
            return max(word_rank(p) for p in parts) * 4 + 1000
        return word_rank(key)

    log('building entries…')
    built: dict[str, dict] = {}
    for key, raw_entries in by_key.items():
        if not key.strip() or len(key) > 40:
            continue
        e = build_entry(key, raw_entries)
        if e:
            e['r'] = rank(key)
            built[key] = e

    log(f'{inherit_korean(built):,} inflected forms borrow Korean from their base word')

    # Inflection map from lemma "forms" (applies/applying/applied -> apply) for Tatoeba matching
    # and for pointer entries of common forms that Wiktionary doesn't list separately.
    form_to_lemma: dict[str, set[str]] = defaultdict(set)
    for key, raw_entries in by_key.items():
        if key in built and 'to' not in built[key]:
            for e in raw_entries:
                for f in e['forms']:
                    fl = f.lower()
                    if fl != key and ' ' not in fl:
                        form_to_lemma[fl].add(key)

    # Selection: the CORE_WORDS most frequent words with a usable entry, then rarer words
    # (single words and phrases) that have Korean, until the size budget is used.
    real = sorted((k for k, e in built.items() if 'to' not in e), key=lambda k: (built[k]['r'], k))
    core_set = set(top[:FREQ_POOL])
    core = [k for k in real if k in core_set][:CORE_WORDS]
    selected = set(core)
    # Pointers for frequent inflections (went, applied) whose lemma is selected.
    for k, e in built.items():
        if 'to' in e and e['r'] <= CORE_WORDS * 2 and e['to'].lower() in selected:
            selected.add(k)
    for f, lemmas in form_to_lemma.items():
        if f not in built and f in rank_of and rank_of[f] <= CORE_WORDS * 2:
            lemma = min((l for l in lemmas if l in selected), key=lambda l: (built[l]['r'], l), default=None)
            if lemma:
                built[f] = {'w': f, 'to': built[lemma]['w'], 'r': rank_of[f]}
                selected.add(f)

    extras = [k for k in real if k not in selected and has_korean(built[k])]

    used = sum(entry_size(built[k]) for k in selected)
    added = 0
    for k in extras:
        size = entry_size(built[k])
        if used + size > SIZE_BUDGET * 0.93:  # leave room for the Korean index
            break
        selected.add(k)
        used += size
        added += 1
    log(f'core {len(core):,}, pointers {sum(1 for k in selected if "to" in built[k]):,}, extra Korean words {added:,}')

    final = {k: built[k] for k in sorted(selected)}
    # Pointers may target words that didn't make the cut.
    for k in [k for k, e in final.items() if 'to' in e and e['to'].lower() not in final]:
        del final[k]

    counts = {}
    if args.subs and args.subs.exists():
        with gzip.open(args.subs, 'rb') as f:
            counts = pickle.load(f)['counts']
    review = load_review(args.review)
    reviewed, ordered = apply_usage(final, counts, review)
    log(f'{reviewed:,} words with reviewed meanings/examples, {ordered:,} more ordered by subtitle usage')

    # ---- write
    out = args.out
    for sub in ('dict', 'ko'):
        if (out / sub).exists():
            shutil.rmtree(out / sub)
        (out / sub).mkdir(parents=True)

    shards: dict[str, dict] = defaultdict(dict)
    for k in sorted(final):
        shards[shard_id(k)][k] = final[k]
    ko_shards = build_ko_index(final)

    version = hashlib.sha1(dumps({'d': shards, 'k': ko_shards}).encode()).hexdigest()[:10]
    files = {}
    for name, data in [(f'dict/{s}.json', d) for s, d in shards.items()] + [(f'ko/{s}.json', d) for s, d in ko_shards.items()]:
        text = dumps({'v': version, 'e': data})
        (out / name).write_text(text, encoding='utf-8')
        files[name] = (len(text.encode()), len(gzip.compress(text.encode(), 9)))

    stats = coverage(final)
    manifest = {
        'version': version,
        'built': time.strftime('%Y-%m-%d'),
        'audioBase': COMMONS + 'transcoded/',
        'sources': {
            'wiktionary': 'https://kaikki.org/dictionary/rawdata.html (CC BY-SA 4.0)',
            'opensubtitles': 'https://www.opensubtitles.org via OPUS (Lison & Tiedemann 2016)',
            'wordfreq': 'https://github.com/rspeer/wordfreq (CC BY-SA 4.0)',
        },
        'dict': sorted(s for s in shards),
        'ko': sorted(s for s in ko_shards),
        'bytes': sum(r for r, _ in files.values()),
        'gzipBytes': sum(g for _, g in files.values()),
        'stats': stats,
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    report(manifest, files)


def coverage(final: dict[str, dict]) -> dict:
    real = {k: e for k, e in final.items() if 'to' not in e}
    tiers = [('top1k', 1_000), ('top3k', 3_000), ('top10k', 10_000), ('top30k', 30_000), ('all', 10**9)]
    stats = {'words': len(real), 'phraseCount': sum(' ' in k for k in real), 'pointers': len(final) - len(real)}
    # Tiers count single words only; phrases get their own row.
    groups = [(name, [e for k, e in real.items() if ' ' not in k and e['r'] <= limit]) for name, limit in tiers]
    groups.append(('phrases', [e for k, e in real.items() if ' ' in k]))
    for name, group in groups:
        n = len(group) or 1
        stats[name] = {
            'words': len(group),
            'korean': round(100 * sum(has_korean(e) or bool(e.get('top')) for e in group) / n, 1),
            'koreanWithBase': round(100 * sum(has_korean(e) or bool(e.get('top')) or 'ofKo' in e for e in group) / n, 1),
            'ordered': round(100 * sum('top' in e for e in group) / n, 1),
            'pairs2': round(100 * sum(len(e.get('eg', [])) >= 2 for e in group) / n, 1),
            'aiExamples': round(100 * sum(any(x.get('a') for x in e.get('eg', [])) for e in group) / n, 1),
            'audio': round(100 * sum('au' in e for e in group) / n, 1),
            'ipa': round(100 * sum('ipa' in e for e in group) / n, 1),
        }
    return stats


def report(manifest, files):
    mb = lambda b: f'{b / 1e6:.1f} MB'
    s = manifest['stats']
    dict_bytes = sum(r for n, (r, _) in files.items() if n.startswith('dict/'))
    ko_bytes = sum(r for n, (r, _) in files.items() if n.startswith('ko/'))
    print(f"\nWordly dictionary {manifest['version']}")
    print(f"  entries: {s['words']:,} ({s['words'] - s['phraseCount']:,} single words, {s['phraseCount']:,} phrases) + {s['pointers']:,} inflection pointers")
    print(f"  size: {mb(manifest['bytes'])} raw ({mb(dict_bytes)} dict, {mb(ko_bytes)} Korean index), "
          f"{mb(manifest['gzipBytes'])} gzipped, {len(files)} files")
    print(f"\n  {'tier':<8}{'words':>8}{'Korean':>9}{'+base':>8}{'ordered':>9}{'≥2 ex.':>9}{'AI ex.':>8}{'audio':>8}{'IPA':>7}")
    for name in ('top1k', 'top3k', 'top10k', 'top30k', 'all', 'phrases'):
        t = s[name]
        print(f"  {name:<8}{t['words']:>8,}{t['korean']:>8}%{t['koreanWithBase']:>7}%{t['ordered']:>8}%"
              f"{t['pairs2']:>8}%{t['aiExamples']:>7}%{t['audio']:>7}%{t['ipa']:>6}%")
    print('\n  Tiers are single words by frequency rank; "phrases" are multi-word entries.')
    print('  +base    = Korean directly, or borrowed from the base word ("years" -> year)')
    print('  ordered  = Korean meanings ordered by real usage (subtitle counts / review)')
    print('  ≥2 ex.   = at least 2 reviewed English-Korean example pairs')
    print('  AI ex.   = at least one example written by Gemini because too few subtitle candidates passed review')


if __name__ == '__main__':
    main()
