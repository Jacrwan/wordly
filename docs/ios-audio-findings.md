# iOS background audio: findings

The original brief asked: does iOS stop Web Speech audio when the screen locks or the app goes to the background, and do Gemini-generated audio files survive better?

## How it was tested

Wordly → 더보기 → 정보·출처 → **백그라운드 오디오 테스트**, in the home-screen app on the user's iPhone (2026-10-17):

- **A. Web Speech:** `speechSynthesis` counts 1, 2, 3… the same way the word player and text reader speak.
- **B. Audio file:** a generated WAV (a beep every second) played through an `<audio>` element, which is how Gemini TTS podcast audio will be played.

The page records what was spoken or played while it was hidden.

## Results

| | Screen locked | Switched to another app |
|---|---|---|
| **A. Web Speech** | ❌ **Stops.** Counting froze at "3" for the whole 16 s the screen was off. | ✅ Keeps playing |
| **B. Audio file (`<audio>`)** | ✅ **Keeps playing** for the whole 16 s | ✅ Keeps playing |

## What this means

- **Podcasts**, the **word player** and the **text reader** all play Gemini TTS audio files through one `<audio>` element, so they keep going with the screen locked or the app in the background. The earlier Web Speech versions of the player and reader were removed (2026-10-17); device voices remain only for tapping a single word's pronunciation and for podcast episodes that have no AI audio.
- **Word player** (단어 듣기): each word's segment (word → Korean → definition → synonyms) is voiced once by Gemini TTS (alternating Kore and Puck voices), cut out of a batch of up to 8 words / 900 characters per request, and cached in IndexedDB (`wordClips`). A listening session joins the cached clips into one WAV.
- **Text reader** (글 읽기): the text is voiced in runs of up to ~1000 characters (one request each, Kore voice, one part per sentence), cached by content in `readerClips` (the newest 60 runs are kept), and each run is cut at its sentence pauses so the current sentence is highlighted and sentences can be tapped or played one at a time.
- Without a family code, or once the day's TTS quota is used up, already-cached audio still plays; anything new waits until AI audio can be made.

## Phone test: background playback

On the iPhone, in the home-screen app, with a family code set and at least 5 saved words:

1. 더보기 → 단어 듣기. It should say how many words still need AI audio.
2. Tap **AI 음성 만들기** and keep the screen on. Progress counts up; a few words take about 10–20 s.
3. Tap ▶. Check the voice reads each word, its Korean meaning, definition and similar words, and the word on screen changes with the audio (not a word early or late).
4. **Lock the screen** for at least 30 s. Audio must keep playing across several words. Unlock, switch to another app for 30 s: it must keep playing.
5. On the lock screen: the title is the current word (Korean meaning underneath). Try ⏭ / ⏮ and pause / play.
6. Leave the player and open it again (or switch filters and back): it should play at once, with no "AI 음성 만들기" step.
7. 더보기 → 글 읽기 → 예시 글 → **읽기**. The AI voice is made right away (one request for the sample); then tap ▶ and lock the screen. Reading must continue, and on unlock the highlighted sentence matches the audio.
8. In the reader, tap a sentence (it jumps there) and try 한 문장씩 (stops after each sentence; ⏭ moves on).
9. Optional: turn on 반복 (loop) and lock the screen; it should start over after the last word.

Report anything that stops, words that are cut off or include the next word, and whether speed changes sound OK.

## Completion checks (2026-10-17)

Recovered Claude's three commits on `codex/lock-screen-player`. The follow-up fixes invalidate the old incorrectly split cache entries, allow cached playback without Gemini credentials, count the character limit in the request estimate, prevent cancelled jobs from starting requests, correct paused seeking, expose playback errors, and clear Media Session handlers when audio playback is unmounted. Silent audio or audio with no feasible sentence alignment is rejected instead of using proportional cuts.

Verified locally:

- `npx tsc --noEmit` and `npm run build` pass.
- `node tests/split.mjs`: 100 seeded synthetic batches, including short headwords, slower Korean, alternating/variable pitch, internal comma pauses and variable sentence gaps; no misplaced cuts in these fixtures. Silent/unsplittable audio is rejected.
- Isolated browser harness (`tests/player.html`): four clips from one mocked TTS request; valid 24 kHz, 16-bit mono WAV and matching session duration; cache invalidation; cancellation; all/learning/due/mastered filters; playback, automatic word progression, next/previous and matching Media Session title.
- After reload: zero TTS requests. Cached playback also works with credentials/model settings removed. Cards, review logs and saved-word state remain unchanged.
- Mocked daily quota: partial cache remains playable with unavailable words disabled; an empty cache switches to device speech and explains the lock-screen limitation.

**Still unverified:** real speech alignment with the alternating voices, and the physical iPhone checklist above. The one attempted live retest was rejected by the proxy with HTTP 401 (`Wrong family code`), before reaching Gemini. The user chose to finish with live verification marked blocked. Synthetic pitch fixtures do not prove that every natural speech batch will split correctly. Old clips need regeneration once valid access is restored.
