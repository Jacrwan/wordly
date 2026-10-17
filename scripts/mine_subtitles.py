"""Mine OpenSubtitles (OPUS, en-ko) for Wordly.

For every dictionary word this counts which Korean meaning translators actually used
("apply" -> 지원하다 667, 적용하다 330, 신청하다 321), which orders Korean meanings by real
usage. For the most frequent words it also keeps the best candidate example pairs for
scripts/review_examples.py to vet.

Inputs: the built dictionary (public/data/dict), the Wiktionary extract cache (for inflected
forms) and the unzipped OpenSubtitles.en-ko.{en,ko} files.

Usage:
  python -I scripts/mine_subtitles.py --dict public/data/dict --extract data-raw/cache/extract-v1.pickle.gz \\
      --subs data-raw/opensubtitles --out data-raw/cache/subs-v1.pickle.gz
"""

from __future__ import annotations

import argparse
import gzip
import heapq
import json
import pickle
import re
import sys
import time
from collections import Counter, defaultdict
from multiprocessing import Pool
from pathlib import Path

from wordfreq import zipf_frequency

CHUNK = 1_000_000  # lines per worker task
CANDIDATE_RANK_LIMIT = 12_000  # keep example candidates for this many top words
PER_BUCKET = 4  # candidates kept per (word, Korean meaning)

TOKEN = re.compile(r"[a-z]+(?:'[a-z]+)?")
CONTROL = re.compile('[​-‏‪-‮⁦-⁩﻿]')
TAGS = re.compile(r'c\.korean|lrm;|rlm;|&[a-z]+;|<[^>]*>|\{[^}]*\}')
JUNK = re.compile(r"[♪♫\[\]()<>{}#*/:@_|~=+\\\"]|http|www\.|\.\.|--")
LATIN = re.compile(r'[A-Za-z]')
HANGUL = re.compile(r'[가-힣]')
PROFANITY_EN = re.compile(
    r"\b(fuck\w*|shit\w*|bitch\w*|bastard\w*|dick\w*|cunt\w*|pussy|asshole\w*|whore\w*|slut\w*|nigg\w*|fag\w*"
    r"|damn\w*|goddamn|piss\w*)\b",
    re.I)
# Movie-violence vocabulary: fine as the word being taught ("kill", "drug"), not as filler.
VIOLENT = {'kill', 'killed', 'killing', 'kills', 'murder', 'murdered', 'dead', 'die', 'died', 'dying', 'blood',
           'bloody', 'gun', 'guns', 'shoot', 'shot', 'drug', 'drugs', 'naked', 'sex', 'sexy', 'ass', 'crap'}
PROFANITY_KO = re.compile(r'(씨발|시발|씨팔|개새|존나|좆|병신|썅|염병|지랄|니미|엿먹|빌어먹|젠장|새끼|섹스|죽여|죽인|살인)')


# ---------------------------------------------------------------- Korean matching

def _syl(L, V, T=0):
    return chr(0xAC00 + (L * 21 + V) * 28 + T)


def _parts(c):
    i = ord(c) - 0xAC00
    return i // 588, (i % 588) // 28, i % 28


def _any_final(L, vowels):
    """Character class: syllable with initial L, one of the vowels, any final consonant."""
    return '[' + ''.join(_syl(L, V, T) for V in vowels for T in range(28)) + ']'


# Vowel a stem's last syllable may contract to before -어/-아/-었 (빌리→빌려, 보→봐, 주→줘, 쓰→써).
CONTRACT = {20: [6], 8: [9], 13: [14], 18: [4, 0], 11: [10]}
WORD_START = r'(?<![가-힣])'


def ko_pattern(meaning: str) -> str | None:
    """Regex that finds a Korean meaning (dictionary form) inside a conjugated sentence."""
    k = re.sub(r'\([^)]*\)|\[[^\]]*\]|[~…·]', '', meaning).strip()
    if not k or not all(HANGUL.match(c) or c == ' ' for c in k) or (' ' in k and len(k) > 6):
        return None
    k = k.replace(' ', '')
    for suffix, endings in (('하다', '하해했합한할함'), ('되다', '되돼됐된될됨'), ('시키다', '시')):
        if k.endswith(suffix) and len(k) > len(suffix):
            noun = k[:-len(suffix)]
            # 걱정하다 also appears as the noun 걱정 ("네 걱정을") — same meaning.
            return re.escape(noun) if len(noun) >= 2 else WORD_START + re.escape(noun) + f'[{endings}]'
    if k.endswith('다') and len(k) >= 2:
        stem = k[:-1]
        L, V, T = _parts(stem[-1])
        options = [re.escape(stem[:-1]) + _any_final(L, [V] + CONTRACT.get(V, []))]
        if V == 18 and L == 5 and T == 0 and len(stem) >= 2:  # 르 irregular: 바르 → 발라/발랐
            pL, pV, pT = _parts(stem[-2])
            if pT == 0:
                options.append(re.escape(stem[:-2] + _syl(pL, pV, 8)) + _any_final(5, [0, 4]))
        if T == 17:  # ㅂ irregular: 어렵 → 어려워
            options.append(re.escape(stem[:-1] + _syl(L, V)) + '[워와웠왔우]')
        if T == 7:  # ㄷ irregular: 듣 → 들어
            options.append(re.escape(stem[:-1] + _syl(L, V, 8)))
        pattern = '(?:' + '|'.join(options) + ')'
        return pattern if len(stem) >= 2 else WORD_START + pattern
    if len(k) >= 2:
        return re.escape(k)
    return WORD_START + re.escape(k) + r'(?:[을를이가은는에도의로와과만]|(?![가-힣]))'


# ---------------------------------------------------------------- word index

def load_targets(dict_dir: Path, extract: Path):
    entries = {}
    for f in sorted(dict_dir.glob('*.json')):
        entries.update(json.loads(f.read_text(encoding='utf-8'))['e'])
    real = {k: e for k, e in entries.items() if 'to' not in e}

    meanings = {}
    for k, e in real.items():
        kos = [s for b in e['pos'] for x in b['s'] for s in x.get('ko', [])] + e.get('ko', []) + e.get('ofKo', [])
        seen, pats = set(), []
        for ko in kos:
            if ko in seen:
                continue
            seen.add(ko)
            p = ko_pattern(ko)
            if p:
                pats.append((ko, p))
        meanings[k] = pats

    by_key = pickle.load(gzip.open(extract))
    token_to_keys: dict[str, set[str]] = defaultdict(set)
    for k in real:
        if ' ' not in k:
            token_to_keys[k].add(k)
            for e in by_key.get(k, []):
                for f in e['forms']:
                    f = f.lower()
                    if f.isalpha() and f != k:
                        token_to_keys[f].add(k)
    for k, e in entries.items():  # pointers: went -> go
        if 'to' in e and e['to'].lower() in real and ' ' not in k:
            token_to_keys[k].add(e['to'].lower())

    phrases: dict[str, str] = {}
    for k in real:
        if ' ' in k:
            head, rest = k.split(' ', 1)
            heads = {head} | {f for f, ks in token_to_keys.items() if head in ks}
            for h in heads:
                phrases[f'{h} {rest}'] = k

    ranks = {k: e['r'] for k, e in real.items()}
    return meanings, dict(token_to_keys), phrases, ranks


# ---------------------------------------------------------------- workers

STATE = {}


def init_worker(meanings, token_to_keys, phrases, ranks, en_path, ko_path):
    STATE.update(
        pats={k: [(ko, re.compile(p)) for ko, p in v] for k, v in meanings.items()},
        token_to_keys=token_to_keys,
        phrases=phrases,
        phrase_lens=sorted({len(p.split()) for p in phrases}),
        ranks=ranks,
        en_path=en_path,
        ko_path=ko_path,
        zipf={},
    )


def zipf(word):
    z = STATE['zipf'].get(word)
    if z is None:
        z = STATE['zipf'][word] = zipf_frequency(word, 'en')
    return z


def clean(s: str) -> str:
    return TAGS.sub('', CONTROL.sub('', s)).strip().lstrip('-–— ').strip()


def candidate_score(en: str, ko: str, toks: list[str], target_tokens: set[str]) -> float | None:
    """Learner-friendliness of a pair, or None if it isn't a clean example sentence."""
    if not 5 <= len(toks) <= 14 or not en[:1].isupper() or en[-1:] not in '.?!':
        return None
    if JUNK.search(en) or JUNK.search(ko) or LATIN.search(ko) or len(HANGUL.findall(ko)) < 4:
        return None
    if not 0.25 <= len(ko) / len(en) <= 1.1 or PROFANITY_EN.search(en) or PROFANITY_KO.search(ko):
        return None
    # Capitalized words mid-sentence are usually names ("Tom", "Mr. Kim"): skip those.
    words = en.split()
    if any(w[:1].isupper() and not w.startswith(('I', "I'")) for w in words[1:]):
        return None
    others = [t for t in toks if t not in target_tokens]
    if any(t in VIOLENT for t in others):
        return None
    if others and min(zipf(t) for t in others) < 2.5:
        return None
    simple = sum(zipf(t) for t in toks) / len(toks)
    return round(simple - 0.12 * abs(len(toks) - 9), 3)


def read_lines(path, offset, n):
    with open(path, 'rb') as f:
        f.seek(offset)
        for _ in range(n):
            line = f.readline()
            if not line:
                return
            yield line.decode('utf-8', errors='replace')


def work(task):
    en_off, ko_off, n = task
    s = STATE
    counts: dict[str, Counter] = defaultdict(Counter)
    heaps: dict[tuple[str, str], list] = defaultdict(list)
    for en_raw, ko_raw in zip(read_lines(s['en_path'], en_off, n), read_lines(s['ko_path'], ko_off, n)):
        en_l = en_raw.lower()
        toks = TOKEN.findall(en_l)
        if not toks:
            continue
        hits: dict[str, set[str]] = {}
        for t in toks:
            for k in s['token_to_keys'].get(t, ()):
                hits.setdefault(k, set()).add(t)
        for n_ in s['phrase_lens']:
            for i in range(len(toks) - n_ + 1):
                k = s['phrases'].get(' '.join(toks[i:i + n_]))
                if k:
                    hits.setdefault(k, set()).update(toks[i:i + n_])
        if not hits:
            continue
        ko = clean(ko_raw)
        en = None
        for k, used in hits.items():
            matched = [ko_word for ko_word, pat in s['pats'].get(k, ()) if pat.search(ko)]
            for m in matched:
                counts[k][m] += 1
            if s['ranks'][k] > CANDIDATE_RANK_LIMIT:
                continue
            if en is None:
                en = clean(en_raw)
            score = candidate_score(en, ko, toks, used)
            if score is None:
                continue
            # Unmatched pairs are kept too (bucket "*"): the reviewer can still judge them,
            # and words with no Korean in the dictionary need them.
            bucket = max(matched, key=len) if matched else '*'
            h = heaps[(k, bucket)]
            item = (score, en, ko)
            if len(h) < PER_BUCKET:
                heapq.heappush(h, item)
            elif item > h[0]:
                heapq.heapreplace(h, item)
    return dict(counts), dict(heaps)


# ---------------------------------------------------------------- main

def chunk_offsets(path: Path) -> list[int]:
    offsets, pos = [0], 0
    with open(path, 'rb') as f:
        for i, line in enumerate(f, 1):
            pos += len(line)
            if i % CHUNK == 0:
                offsets.append(pos)
    return offsets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dict', type=Path, required=True)
    ap.add_argument('--extract', type=Path, required=True)
    ap.add_argument('--subs', type=Path, required=True, help='folder with OpenSubtitles.en-ko.en/.ko')
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--workers', type=int, default=8)
    args = ap.parse_args()

    t0 = time.time()
    meanings, token_to_keys, phrases, ranks = load_targets(args.dict, args.extract)
    print(f'{len(meanings):,} words, {sum(map(len, meanings.values())):,} Korean meaning patterns, '
          f'{len(phrases):,} phrase forms', file=sys.stderr)

    en_path = args.subs / 'OpenSubtitles.en-ko.en'
    ko_path = args.subs / 'OpenSubtitles.en-ko.ko'
    en_offs, ko_offs = chunk_offsets(en_path), chunk_offsets(ko_path)
    assert len(en_offs) == len(ko_offs), 'English and Korean files have different line counts'
    tasks = [(e, k, CHUNK) for e, k in zip(en_offs, ko_offs)]
    print(f'{len(tasks)} chunks of {CHUNK:,} lines ({time.time() - t0:.0f}s)', file=sys.stderr)

    counts: dict[str, Counter] = defaultdict(Counter)
    best: dict[tuple[str, str], list] = defaultdict(list)
    with Pool(args.workers, init_worker, (meanings, token_to_keys, phrases, ranks, str(en_path), str(ko_path))) as pool:
        for i, (c, h) in enumerate(pool.imap_unordered(work, tasks), 1):
            for k, ctr in c.items():
                counts[k].update(ctr)
            for key, items in h.items():
                merged = best[key] + items
                best[key] = heapq.nlargest(PER_BUCKET, merged)
            print(f'  chunk {i}/{len(tasks)} ({time.time() - t0:.0f}s)', file=sys.stderr, flush=True)

    cands: dict[str, list] = defaultdict(list)
    for (k, bucket), items in best.items():
        cands[k].extend((score, en, ko, bucket) for score, en, ko in items)
    out = {
        'counts': {k: dict(v.most_common()) for k, v in counts.items()},
        'cands': {k: sorted(v, reverse=True) for k, v in cands.items()},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.out, 'wb') as f:
        pickle.dump(out, f, protocol=pickle.HIGHEST_PROTOCOL)
    with_counts = sum(1 for v in out['counts'].values() if v)
    print(f'done in {time.time() - t0:.0f}s: meaning counts for {with_counts:,} words, '
          f'candidates for {len(out["cands"]):,} words -> {args.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
