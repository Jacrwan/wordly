import { useCallback, useEffect, useState } from 'preact/hooks';
import { AiUnavailable, cachedFill, getAiFill } from '../ai/dictionary';
import { GeminiError } from '../ai/gemini';
import { aiNeeds, buildView, findEntry, normalize } from '../dict/lookup';
import type { AiFill, DictEntry, WordView } from '../dict/types';
import { useApp } from '../state';

export type WordState =
  | { status: 'loading' }
  | { status: 'aiSearching' } // not in the dictionary; asking Gemini
  | { status: 'offline' }
  | { status: 'notFound'; suggestion?: string; aiUnavailable?: boolean; aiError?: boolean }
  | { status: 'ready'; view: WordView; via?: string };

export type AiState = 'idle' | 'loading' | 'waiting' | 'error' | 'unavailable';

/** Loads a word: the dictionary entry right away, then (once, cached) Gemini's gap-fill. */
export function useWord(query: string): { state: WordState; ai: AiState; aiError: string; retry: () => void } {
  const { settings } = useApp();
  const [state, setState] = useState<WordState>({ status: 'loading' });
  const [ai, setAi] = useState<AiState>('idle');
  const [aiError, setAiError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const set = (s: WordState) => live && setState(s);
    setAi('idle');
    setState({ status: 'loading' });

    (async () => {
      const found = await findEntry(query);
      const key = found.key;
      const entry: DictEntry | null = found.kind === 'found' ? found.entry : null;
      const via = found.kind === 'found' ? found.via : undefined;
      const cached = await cachedFill(key);

      if (found.kind === 'offline' && !cached) return set({ status: 'offline' });

      const show = (fill: AiFill | null) => {
        const view = buildView(key, entry, fill);
        if (view) return set({ status: 'ready', view, via });
        const suggestion = fill?.word && normalize(fill.word) !== key ? fill.word : undefined;
        set({ status: 'notFound', suggestion });
      };

      if (entry) show(cached);
      if (cached || !aiNeeds(entry).length) {
        if (!entry) show(cached);
        return;
      }

      if (!entry) set({ status: 'aiSearching' });
      else live && setAi('loading');
      try {
        const fill = await getAiFill(key, entry, settings, () => live && entry && setAi('waiting'));
        if (!live) return;
        setAi('idle');
        show(fill);
      } catch (e) {
        if (!live) return;
        const unavailable = e instanceof AiUnavailable;
        // "busy" is shown as a friendly rate-limit message; other errors show their text.
        setAiError(unavailable ? '' : e instanceof GeminiError && e.kind === 'rate-limit' ? 'busy' : (e as Error).message);
        if (entry) setAi(unavailable ? 'unavailable' : 'error');
        else set({ status: 'notFound', aiUnavailable: unavailable, aiError: !unavailable });
        if (!unavailable) console.warn('AI fill failed', e);
      }
    })();

    return () => {
      live = false;
    };
  }, [query, attempt, settings.familyCode, settings.apiKey, settings.models?.lookup]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, ai, aiError, retry };
}
