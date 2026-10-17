import { render } from 'preact';
import { App } from './app';
import { requestPersistence } from './pwa';
import { AppStateProvider } from './state';
import './styles.css';

requestPersistence();

render(
  <AppStateProvider>
    <App />
  </AppStateProvider>,
  document.getElementById('app')!,
);
