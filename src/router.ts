import { useEffect, useState } from 'preact/hooks';

export type Route =
  | 'search' | 'words' | 'review' | 'more' | 'word'
  | 'settings' | 'about' | 'player' | 'reader' | 'packs' | 'chat' | 'podcast' | 'audiotest';

const routes: Route[] = ['search', 'words', 'review', 'more', 'word', 'settings', 'about', 'player', 'reader', 'packs', 'chat', 'podcast', 'audiotest'];

export interface Location {
  name: Route;
  param?: string; // e.g. the word in #/word/apply
}

function parse(): Location {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const param = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  return (routes as string[]).includes(name) ? { name: name as Route, param } : { name: 'search' };
}

export function useRoute(): Location {
  const [loc, setLoc] = useState(parse);
  useEffect(() => {
    const onChange = () => setLoc(parse());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return loc;
}

export const href = (r: Route, param?: string) => `#/${r}${param ? `/${encodeURIComponent(param)}` : ''}`;

export function go(r: Route, param?: string): void {
  location.hash = href(r, param);
}

/** Back within the app if there's history, otherwise to a sensible screen. */
export function back(fallback: Route): void {
  if (history.length > 1) history.back();
  else go(fallback);
}
