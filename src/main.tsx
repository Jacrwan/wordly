import { render } from 'preact';
import { App } from './app';
import { requestPersistence } from './pwa';
import { AppStateProvider } from './state';
import './styles.css';

requestPersistence();

// iOS can leave the page shifted up after the keyboard closes; put it back.
document.addEventListener('focusout', () => setTimeout(() => window.scrollTo(0, 0), 50));

// iOS only lets a page speak after speech was started inside a tap. Speak a silent utterance on
// the first tap so later speech that starts on its own (a chat greeting arriving a few seconds
// later, the next word in the player) isn't silently blocked.
function unlockSpeech() {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  synth.speak(u);
  document.removeEventListener('touchend', unlockSpeech, true);
  document.removeEventListener('click', unlockSpeech, true);
}
document.addEventListener('touchend', unlockSpeech, true);
document.addEventListener('click', unlockSpeech, true);

render(
  <AppStateProvider>
    <App />
  </AppStateProvider>,
  document.getElementById('app')!,
);
