import { registerSW } from 'virtual:pwa-register';

type Listener = () => void;

export const pwaState = { needRefresh: false, offlineReady: false };
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function onPwaChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const updateSW = registerSW({
  onNeedRefresh() {
    pwaState.needRefresh = true;
    emit();
  },
  onOfflineReady() {
    pwaState.offlineReady = true;
    emit();
  },
});

export function dismissPwa(): void {
  pwaState.needRefresh = false;
  pwaState.offlineReady = false;
  emit();
}

// Ask the browser not to evict our IndexedDB data (dictionary + saved words).
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // Not supported; nothing to do.
  }
}
