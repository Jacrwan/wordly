import { render } from 'preact';
import { App } from './app';
import { requestPersistence } from './pwa';
import { AppStateProvider } from './state';
import './styles.css';

requestPersistence();

// iOS can leave the page shifted up after the keyboard closes; put it back.
document.addEventListener('focusout', () => setTimeout(() => window.scrollTo(0, 0), 50));

render(
  <AppStateProvider>
    <App />
  </AppStateProvider>,
  document.getElementById('app')!,
);
