# Lock-screen player regression checks

Run `node tests/split.mjs` from the repository root (Node 24+). It bundles the actual splitter with the installed Rolldown dependency and checks 100 seeded batches with alternating pitches, varying pauses, short headwords and slower Korean. Silent and unsplittable responses must fail instead of being cached with guessed boundaries. Synthetic tones do not establish real speech alignment accuracy.

For browser integration checks, start `npm run dev -- --port 5175 --strictPort`, then open `/wordly/tests/player.html` on **localhost:5175**. Use a fresh test origin/browser profile. The harness refuses a preexisting non-test database; it creates four test words and an FSRS baseline, intercepts TTS requests locally, and never contacts Gemini. It checks batching, WAV format/timeline, cache invalidation, cancellation, quota errors and unchanged FSRS data before mounting the real player. Test files are not part of the production build.

1. Make the four clips: expect one UI request, four cached clips, unchanged FSRS data.
2. Play, next/previous, choose a word, and switch All/Learning/Due/Mastered.
3. Reload: expect zero requests and immediately available playback.
4. Use the harness's “Test without credentials” button: cached audio must still play.
5. Use the partial/empty quota buttons, then Make AI audio: expect cached-only playback, or a "used up, try tomorrow" message when nothing is cached (there is no device-voice fallback any more).
6. Observe the current word and Media Session title; they should agree during playback.

Real Gemini and physical iPhone testing are separate; see `docs/ios-audio-findings.md`.
