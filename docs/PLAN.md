# Wordly — Build Plan

This plan covers eight steps, built in order. Each step ends with a **phone checklist** that has to pass on a real iPhone before the next step starts. Claude can check layout and the install flow in the iOS Simulator, but anything about audio, backgrounding, the microphone or storage has to be checked on the real device.

---

## 0. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Vite + Preact + TypeScript | Tiny runtime (about 4 KB), React-style components, fast on older phones |
| Routing | Hash router (`#/search`, `#/words`…) | GitHub Pages has no SPA fallback, and hash routes avoid 404s on reload |
| PWA | `vite-plugin-pwa` (Workbox, `generateSW`) | Precaches the app shell and versions it with an update prompt |
| Storage | Dexie over IndexedDB | Indexed queries for filters and due dates, plus schema migrations |
| SRS | `ts-fsrs` | Required by the spec |
| Repo | `github.com/Jacrwan/wordly` (public) → `https://jacrwan.github.io/wordly/` | Pages on a free plan needs a public repo. Confirm before creating it. |
| Deploy | GitHub Actions → Pages (`actions/deploy-pages`) | Pushing to `main` deploys |
| AI model names | Resolved from `GET /v1beta/models` at build time **and** at runtime | Aliases change. Settings shows the models that were found. |

### Gemini model selection
- The **models list call happens first** (`GET https://generativelanguage.googleapis.com/v1beta/models?key=…`). It needs your key, so it runs at the start of step 3. Its output gets pasted into `src/ai/models.ts` as defaults.
- At runtime, **Settings → Test key** calls the same endpoint and picks:
  - `lookup`: the current Flash alias (e.g. `gemini-flash-latest`), used for lookups, 쉬운 설명 and packs.
  - `long`: the current Pro model, used for podcast scripts and conversation. It falls back to Flash if the median latency is above about 8 s.
  - `tts`: a model whose name contains `tts` and that supports multi-speaker output.
- Every structured call uses `responseMimeType: "application/json"` with a `responseSchema`, and the result is checked against a local TypeScript schema before it's used.

---

## 1. Data model (IndexedDB via Dexie)

| Store | Key | Contents |
|---|---|---|
| `settings` | `id='app'` | `uiLang` (`ko` default), `apiKey`, `models{lookup,long,tts}`, `profile{ageRange,occupation,level,goals[]}`, `speech{enVoice,koVoice,rate}` |
| `dictShards` | `shardId` | Downloaded shard JSON plus `version`. Holds both English shards (`ap`) and Korean index shards (`ko-03`). |
| `aiEntries` | `word` | Gemini-generated or gap-filled entry in the **same shape** as a dictionary entry. Permanent: never regenerated. |
| `easyNotes` | `word` | 쉬운 설명 text and `createdAt` (AI) |
| `myWords` | `word` | `addedAt`, `status` (`learning`/`mastered`/`archived`), `source` (search/pack/reader/…), snapshot of the card |
| `cards` | `[word+dir]` | FSRS card state for each direction: `dir = 'en2ko'` (recognition) or `'ko2en'` (recall). Indexed by `due`. |
| `reviewLogs` | auto | `word`, `dir`, `rating`, `source` (`review`/`conversation`), `ts` |
| `packs` | `id` | Fixed or generated packs: `title`, `level`, `words[]`, `generatedFrom` (profile hash) |
| `chats` | auto | `scenario`, `messages[]`, `wordsUsed[]`, `startedAt` |
| `podcasts` | auto | `title`, `level`, `words[]`, `script[]` (speaker/text/highlights), `audio` (Blob, nullable), `audioSource` (`gemini`/`webspeech`) |

### Mastery rules
- Saving a word creates both FSRS cards. Archived words are left out of review and playback.
- A word becomes **mastered** when both cards are in the `Review` state with a scheduled interval of **21 days or more**.
- An `Again` rating drops the word back to **learning**. Mastered words still come back when FSRS schedules them.
- Only `review` and `conversation` (correct use) write FSRS ratings. Playback, the reader and podcasts never do.

---

## Step 1: PWA shell, data model, Settings, deploy

**Build**
- Vite + Preact + TS scaffold, the hash router and a bottom tab bar (검색 / 내 단어 / 복습 / 더보기).
- i18n: `ko.ts` and `en.ts` string tables with a toggle in Settings. Korean is the default.
- Dexie schema for every store above (empty stores are fine for now).
- Settings: API key field (masked) with a **Test** button that lists models, a profile form, a language toggle, and **Backup export/import** (JSON).
- PWA: `manifest.webmanifest` (`display: standalone`, `start_url: ./`, `scope: ./`), 192/512/maskable icons, `apple-touch-icon` (180×180), `apple-mobile-web-app-capable`, status-bar meta, safe-area CSS (`env(safe-area-inset-*)`).
- Call `navigator.storage.persist()` on first launch.
- `.github/workflows/deploy.yml` → Pages, with `base: '/wordly/'`.

**Phone checklist**
- [ ] Safari → Share → Add to Home Screen shows the Wordly icon and name.
- [ ] Opens full-screen (no Safari bar) and the notch / home indicator don't cover the UI.
- [ ] Airplane mode → relaunch → the shell still loads.
- [ ] Enter the key → Test → the model list appears. Kill the app and reopen: the key is still there.
- [ ] Toggle 한국어/English and the whole UI switches.

---

## Step 2: Dictionary build (`/scripts`)

**Sources** (checked on 2026-10-16)

| File | Size |
|---|---|
| `kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl` (English-only extraction) | 3.3 GB, uncompressed |
| `downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2` | 25 MB |
| `…/per_language/kor/kor_sentences.tsv.bz2` | 194 KB, about 15.9k sentences |
| `…/per_language/kor/kor-eng_links.tsv.bz2` | 69 KB, about **11.6k pairs** |
| `wordfreq` (pip) | `top_n_list('en', N)` for ranks |

**Pipeline** (`scripts/build_dict.py`, streaming, never loads the 3.3 GB file into memory)
1. Download into `/data-raw/` (gitignored), skipping files that are already there.
2. Get the wordfreq ranks for the top 60k, so later steps can choose candidates from them.
3. Stream the Wiktionary JSONL and keep `lang_code == "en"`. For each word, merge all its POS entries:
   - `pos`, `ipa` (first US IPA, else first IPA), `audio` (first `mp3_url`, preferring US). Only mp3 is kept, because iOS can't play ogg.
   - `senses`: gloss plus up to 2 Wiktionary examples per sense, at most 6 senses. Senses tagged `obsolete`/`archaic`/`rare` and pure "form of" senses are dropped.
   - `syn` / `ant`: at most 8 each.
   - `ko`: Korean translations (`lang_code == "ko"`), matched to a sense by the translation's `sense` text using token overlap. Unmatched translations go into a word-level `ko` list.
   - **Inflections** (`went`, `running`): stored as a pointer `{ "lemma": "go" }`, so a lookup redirects to the lemma.
4. Choose the word set: the top 30,000 by rank, plus rarer words that **have a Korean translation**, added in rank order until the size budget is used up.
5. Tatoeba: join English↔Korean pairs, tokenize the English side, and give each word up to 3 pairs, shortest first. A word appearing in an inflected form also counts for its lemma.
6. Korean reverse index: normalize each Korean term (trim particles and parentheticals), map it to a list of English words ranked by frequency, and shard it by initial consonant (choseong) into `ko-00…ko-18.json`.
7. Write `public/data/dict/{first two letters}.json`. One-letter words go to `{x}_.json` and non-alpha words to `_misc.json`. Also write `public/data/manifest.json` with the shard list, sizes and a version hash.
8. **Report**: total size (raw and gzip), word count, % of words with a Korean translation, % with at least 2 Tatoeba pairs, and the top-1k / top-10k coverage split.

**Size plan.** Target 30 MB or less raw, at roughly 800 B per word × 30k ≈ 24 MB plus the Korean index. GitHub Pages serves JSON gzipped, so actual downloads are about 4× smaller.

**Entry shape** (shared by the dictionary, AI gap-fill and the result card)
```jsonc
{ "w": "apply", "r": 812, "ipa": "/əˈplaɪ/", "audio": "https://upload.wikimedia.org/…mp3",
  "pos": [{ "p": "verb", "senses": [{ "g": "To make a formal request", "ko": ["지원하다","신청하다"], "ex": ["…"] }] }],
  "syn": ["…"], "ant": ["…"], "pairs": [{ "en": "…", "ko": "…" }], "ai": [] /* AI-filled field names */ }
```

**Offline.** Shards download on first lookup and are stored in `dictShards`. Settings also has **Download full dictionary** for complete offline use.

**About screen** credits Wiktionary (CC BY-SA 4.0), Tatoeba (CC BY 2.0 FR), wordfreq (CC BY-SA 4.0) and Wikimedia Commons audio.

> ⚠️ **Expected gap: example sentences.** There are only about 11.6k en–ko Tatoeba pairs, and the spec wants **2 or more examples, each with a Korean translation**. That means Gemini will probably fill examples for most words beyond the top few thousand. The step-2 report will give the real number. Options are listed under Open questions.

---

## Step 3: Lookup, save, My Words

- **Search**: input detection. Hangul goes to the Korean reverse index, which returns a list of English words with their Korean meanings. Latin text goes to the shard. Inflections redirect to the lemma. Suggestions come from prefix matches in the loaded shard.
- **Gemini gap-fill** runs only when one of these is true:
  1. the word isn't in the dictionary,
  2. no sense has Korean,
  3. there are fewer than 2 Korean-translated examples.

  The request asks only for the **missing fields**, with a strict JSON schema in the entry shape. The result is merged and written to `aiEntries` permanently, and the field names go into `ai[]`. The rule is enforced in code with a single `getEntry(word)` choke point and an in-flight dedupe map, so two quick taps don't make two calls.
- **Result card**: word, IPA, 🔊, POS, Korean meanings, English definition, 3–5 synonyms, 2 or more examples with Korean translations. AI fields get an `AI` chip.
- **Pronunciation**: play `audio` (Wikimedia mp3) through `<audio>`. If there's none, or it fails, use `speechSynthesis` with an `en-US` voice.
- **Save**: write `myWords` and two FSRS cards. On the **first** save, generate 쉬운 설명 (1–2 Korean sentences on nuance and usage) and cache it in `easyNotes`.
- **My Words**: list, search, filter chips (학습 중 / 완료 / 보관), swipe or long-press to archive or unarchive, and a count per status.

**Phone checklist**: lookup works offline for a word already fetched, Korean search returns English, the AI chip shows up, there's no second Gemini call on re-lookup (check the network log), audio plays on the iPhone speaker with the silent switch on and off.

## Step 4: FSRS review

- A queue of due cards (`cards.due <= now`), alternating directions, with a daily new-card cap that can be changed in Settings.
- **en2ko**: show the word and 🔊, then tap to reveal the Korean meaning. **ko2en**: show the Korean meaning and tap to reveal the word.
- Again / Hard / Good / Easy buttons, each showing its next interval (from `ts-fsrs` `repeat()`).
- After every rating, recompute mastery status. A summary screen ends the session.

**Phone checklist**: intervals look sensible, kill the app mid-session and nothing is lost, a mastered word reappears when its due date is moved forward in a debug panel.

## Step 5: Audio playback and text reader

- **Speech engine**: a queue of `SpeechSynthesisUtterance` segments, each tagged `en` or `ko` and given the right voice (iOS: Samantha/Ava for en-US, Yuna for ko-KR). Voices load asynchronously and get picked in Settings. The first `speak()` has to come from a tap, which iOS requires.
- **Player**: filter (all / learning / due / pack), sequence word → Korean meaning → definition → synonyms, play/pause/skip/back, speed 0.5–1.5×, loop. Media Session metadata is set where it has an effect.
- **Reader**: textarea → sentence split (`Intl.Segmenter`, with a regex fallback) → play all, or step sentence by sentence with the current sentence highlighted, at an adjustable speed with loop. Each word is a tap target that opens the result card in a sheet with Save.

**Backgrounding test (spec requirement).** Each case is recorded in `docs/ios-audio-findings.md`:

| Case | Web Speech | `<audio>` file (Gemini TTS / mp3) |
|---|---|---|
| Screen lock during playback | ? | ? |
| Switch to another app | ? | ? |
| Return to app | resumes? restarts? | ? |
| Silent switch on | ? | ? |
| Home-screen PWA vs Safari tab | ? | ? |

Expected result, to be confirmed: iOS pauses or kills `speechSynthesis` once the app goes to the background, while `<audio>` with Media Session keeps playing. If that holds, the fallback plan is **pre-rendered playback**: Gemini TTS audio for a playlist, cached in IndexedDB, played as one file.

## Step 6: Recommendations

- **Level from rank**: Beginner ≤ 3,000, Intermediate ≤ 10,000, Advanced > 10,000.
- **Fixed packs** live in `public/packs/*.json` as word lists I write by hand (no runtime AI): Workplace, Medical, Housing/Banking, Visa/Immigration, TOEFL, and **Konglish false friends** (hand phone, fighting, service, one-shot, apart, cunning, eye shopping, notebook, sharp pen, skinship, …). Each Konglish item gets a short Korean note on what the English actually means.
- **Profile packs**: Gemini (Flash) returns `{title, words[]}` from the profile plus the user's level, with saved words excluded. The result is cached in `packs` by profile hash.
- Every pack word goes through `getEntry()`, so the local dictionary comes first. Words are filtered or tagged by level. The pack screen offers **Add** per word and **Add all**.

## Step 7: Conversation

- Scenario picker: job interview, doctor's visit, landlord, coworker small talk, restaurant, free talk.
- The system prompt includes the scenario, the profile level and a target list of 5–8 saved words, due ones first.
- Each turn returns structured JSON:
  ```jsonc
  { "reply": "…", "correction": null | { "original": "…", "better": "…", "noteKo": "…" },
    "targetWordsUsedCorrectly": ["…"], "targetWordsMisused": ["…"] }
  ```
- Each correctly used target word logs an FSRS **Good** on its `ko2en` card, at most once per word per chat. Misuse shows a short correction bubble and logs no rating.
- Text input first. Mic button uses `webkitSpeechRecognition` and is hidden when it isn't supported. Replies can be read aloud with an auto-read toggle.

**Phone checklist**: mic works or is hidden in the home-screen app, a corrected word is visible in the review log.

## Step 8: Podcast

- Word selection: 8–12 saved words, due soonest first, then learning words.
- Gemini (`long` model) script, structured as `[{ speaker: "A"|"B", text, savedWords[] }]`, for a 3–5 minute target (about 450–750 English words).
  - **Beginner**: Korean narration, English target words with a Korean gloss.
  - **Intermediate**: English, with a Korean gloss only the first time a saved word appears.
  - **Advanced**: all English.
- **Audio**: the Gemini multi-speaker TTS model with 2 named voices. It returns 24 kHz 16-bit PCM, which gets wrapped in a WAV header to make a Blob, and the Blob goes into `podcasts.audio`. Long scripts are split into chunks and the chunks joined. If TTS isn't available, fails, or takes too long (more than about 60 s), it falls back to Web Speech with two different system voices.
- Transcript with saved words highlighted. Tapping one opens its card. Line sync uses time estimated from character counts. There's a list of past episodes, and replaying never regenerates.

**Phone checklist**: an episode keeps playing with the screen locked (Gemini audio), it replays in airplane mode, and the IndexedDB size per episode is reasonable.

---

## Cross-cutting

- **Privacy**: the key and all data stay on the device, and Gemini is the only external call. The in-app key screen advises a referrer-restricted key. Free-tier Gemini traffic may be used by Google to improve its models, and Settings says so.
- **Errors**: there's an offline banner, and AI features turn off cleanly when there's no key or no network. Gemini 429/5xx responses get a short retry, then a friendly message in Korean.
- **Backup**: export and import of `myWords`, `cards`, `reviewLogs`, `easyNotes` and `aiEntries` as one JSON file. On-device-only storage makes this the only safety net.
- **iOS storage**: the home-screen app has storage separate from Safari. `persist()` is requested, and storage usage is shown in Settings.
- **Accessibility for older users**: base font of at least 18 px, large tap targets (≥ 48 px), high contrast, and a Dynamic Type friendly layout.

## Open questions

1. **Repo**: is it OK to create a **public** repo `Jacrwan/wordly`? GitHub Pages on a free plan needs a public repo.
2. **Example sentences**: if the step-2 report confirms low Tatoeba coverage, which option do you want?
   - (a) Keep the spec as written, with Gemini filling examples per word on first lookup and caching them.
   - (b) Run a one-time **build-time** Gemini batch for the top ~5k words using your key locally, and commit the output (marked AI).
   - (c) Accept English-only Wiktionary examples and require only 1 translated pair.
3. **Mastery threshold**: is 21 days in both directions fine, or do you want it stricter or looser?
