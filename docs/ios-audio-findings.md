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
- **Planned (step 8):** a "play with the screen locked" option for the word player. Each word's segment (word → Korean → definition → synonyms) is generated once with Gemini TTS, cached in IndexedDB, and played as audio files. TTS models have their own free-tier daily limits, so audio is generated per word, once, and only on request.
