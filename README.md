# Wordly

An English vocabulary app for Korean speakers. It's an installable PWA (Progressive Web App) that runs fully on the phone. There are no accounts, and every bit of user data stays in the device's IndexedDB. The only server is a tiny Cloudflare Worker that holds the Gemini key. The UI is Korean by default and can be switched to English.

> **Status:** step 1 of 8 (PWA shell + Settings) is done. Live at https://jacrwan.github.io/wordly/. See [docs/PLAN.md](docs/PLAN.md) for the build order, the data model and the per-step phone test checklists.

## Features

| Area | What it does |
|---|---|
| **Lookup** | Search an English word, or a Korean word to find English words for it. Lookups come from a bundled offline dictionary first, and Gemini fills only the gaps. |
| **Result card** | Shows IPA, part of speech, Korean meanings, English definition, synonyms, example sentences with Korean translations, and a 🔊 pronunciation button. AI-generated fields carry a small `AI` tag. |
| **My Words** | Saved words with search and filters (learning / mastered / archived). The first save also generates a plain-Korean *쉬운 설명* (easy explanation). |
| **Review** | Spaced repetition with [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) in both directions (English → Korean and Korean → English), rated Again / Hard / Good / Easy. |
| **Audio playback** | Plays saved words in a hands-free loop: word → Korean meaning → definition → synonyms. Speed runs from 0.5 to 1.5×. |
| **Text reader** | Paste any text and have it read aloud, sentence by sentence with a highlight. Tap a word to look it up. |
| **Recommendations** | Word packs generated from your profile, plus fixed packs: Workplace, Medical, Housing/Banking, Visa/Immigration, TOEFL and Konglish false friends. |
| **Conversation** | Role-play chats (job interview, doctor, landlord, coworker, restaurant, free talk) that steer you toward your saved words and correct misuse. |
| **Podcast** | Two-host episodes of 3–5 minutes built around 8–12 of your words that are due for review, at Beginner, Intermediate or Advanced language level. |

Mastery only goes up through **active recall**: reviewing a word, or using it correctly in a conversation. Listening never counts.

## Tech stack

- **Vite + Preact + TypeScript** builds a small, fast static app.
- **vite-plugin-pwa** (Workbox) generates the manifest and service worker.
- **Dexie** wraps IndexedDB.
- **ts-fsrs** does the spaced-repetition scheduling.
- **Google Gemini API**, reached through a small **Cloudflare Worker** proxy (`/worker`) that holds the key. Phones unlock it with a family code.
- **Web Speech API** handles speech synthesis and, where supported, speech recognition.
- **GitHub Pages** hosts the app and **GitHub Actions** deploys it.
- **Python 3** scripts in `/scripts` build the dictionary once. Their output is committed.

## Project layout (planned)

```
/scripts          Python dictionary build (run once, by hand)
/worker           Cloudflare Worker: Gemini proxy (holds the API key)
/data-raw         Downloaded source dumps (gitignored, several GB)
/public/data/dict Sharded English dictionary JSON (committed), e.g. ap.json
/public/data/ko   Korean → English reverse index shards (committed)
/public/packs     Fixed word packs (committed)
/src
  /db             Dexie schema + repositories
  /dict           Shard loader, lookup, Korean reverse lookup
  /ai             Gemini client, schemas, prompts, TTS
  /srs            FSRS wrapper, mastery rules
  /speech         Web Speech helpers (voices, queueing, recognition)
  /screens        Search, Card, MyWords, Review, Player, Reader, Packs, Chat, Podcast, Settings, About
  /i18n           ko.ts / en.ts UI strings
docs/PLAN.md      Build plan
```

## Development

```bash
npm install
npm run dev          # local dev server
npm run build        # production build to /dist
npm run preview      # serve the production build
```

The dictionary build is only needed when you regenerate the data:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/build_dict.py      # downloads sources into /data-raw, writes /public/data
```

## Gemini proxy (Cloudflare Worker)

The app is static, so it can't keep a secret. It calls `/worker` instead. The Worker:

- checks the `X-Family-Code` header against the `FAMILY_CODE` secret, and locks out an IP after 10 wrong codes in a minute,
- adds the `GEMINI_API_KEY` secret and forwards only the Gemini endpoints the app uses (list models, generate, stream, count tokens),
- allows requests only from the app's origins, and caps total use at 60 requests a minute.

One-time setup (the secrets are typed into Wrangler and never committed):

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put FAMILY_CODE
npx wrangler deploy
```

The Worker is deployed at `https://wordly-proxy.jacrwan.workers.dev`; `src/ai/config.ts` points to it. To run the Worker locally, copy `worker/.dev.vars.example` to `worker/.dev.vars`, then run `npm run dev` in `/worker`, and set `VITE_PROXY_URL=http://localhost:8787` in `.env.development.local`.

In the app: **설정 → AI 연결 → 가족 코드**, entered once per phone. Under **고급**, a user can paste their own AI Studio key instead. That key stays on the device and takes priority over the proxy.

## Install on iPhone (아이폰에 설치하기)

1. **Safari**에서 앱 주소를 엽니다. Chrome에서는 홈 화면 추가가 제대로 되지 않을 수 있습니다.
2. 아래쪽 **공유 버튼(□↑)** → **홈 화면에 추가**를 누릅니다.
3. 홈 화면에 생긴 **Wordly** 아이콘으로 앱을 엽니다.
4. **더보기 → 설정 → AI 연결**에 **가족 코드**를 한 번 입력하고 **연결 확인**을 누릅니다. 홈 화면 앱은 Safari와 저장 공간이 따로라서, 설치한 **뒤에** 앱 안에서 입력해야 합니다.

All data lives on the phone. Use **Settings → Backup** to export your words before you switch phones or delete the app.

## Data sources & attribution

| Source | Used for | License |
|---|---|---|
| [Wiktionary](https://en.wiktionary.org/) via [kaikki.org / wiktextract](https://kaikki.org/dictionary/rawdata.html) | Definitions, IPA, synonyms, Korean translations, audio links | CC BY-SA 4.0 |
| [Tatoeba](https://tatoeba.org/) | English–Korean sentence pairs | CC BY 2.0 FR |
| [wordfreq](https://github.com/rspeer/wordfreq) | Word frequency ranks | Data: CC BY-SA 4.0 |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Pronunciation recordings (streamed, not bundled) | Per-file (mostly CC BY-SA) |

The generated dictionary files under `/public/data` are derived from Wiktionary and are distributed under **CC BY-SA 4.0**. The same attribution is shown on the app's **About** screen.

## License

Code: MIT (see [LICENSE](LICENSE)). Dictionary data: CC BY-SA 4.0 (see above).
