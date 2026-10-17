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

- The **word player** and **text reader** (Web Speech) work in the background when switching apps, but **stop when the screen locks**. The player tells the user this.
- **Podcasts (step 8)** will use Gemini TTS audio files played through `<audio>`, so they keep playing with the screen locked, as the brief expected.
- **Word player, lock-screen mode:** 단어 듣기 → **화면 잠금 재생**. Each word's segment (word → Korean → definition → synonyms) is voiced once by Gemini TTS (voice Kore), cut out of a batch of up to 8 words per request, and cached in IndexedDB (`wordClips`). A listening session joins the cached clips into one WAV played by a single `<audio>` element, so it is the same kind of playback that passed test B. When the day's TTS quota runs out before any clip exists, the player switches back to device voices.

## Phone test: lock-screen word player

On the iPhone, in the home-screen app, with a family code set and at least 5 saved words:

1. 더보기 → 단어 듣기 → tap **화면 잠금 재생**. It should say how many words still need AI audio.
2. Tap **AI 음성 만들기** and keep the screen on. Progress counts up; a few words take about 10–20 s.
3. Tap ▶. Check the voice reads each word, its Korean meaning, definition and similar words, and the word on screen changes with the audio (not a word early or late).
4. **Lock the screen** for at least 30 s. Audio must keep playing across several words.
5. On the lock screen: the title is the current word (Korean meaning underneath). Try ⏭ / ⏮ and pause / play.
6. Unlock: the screen shows the word that is playing.
7. Leave the player and open it again (or switch filters and back): it should play at once, with no "AI 음성 만들기" step.
8. Optional: turn on 반복 (loop) and lock the screen; it should start over after the last word.

Report anything that stops, words that are cut off or include the next word, and whether speed changes sound OK.
