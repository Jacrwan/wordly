import { useEffect, useState } from 'preact/hooks';

export type Route =
  | 'search' | 'words' | 'review' | 'more'
  | 'settings' | 'about' | 'player' | 'reader' | 'packs' | 'chat' | 'podcast';

const routes: Route[] = ['search', 'words', 'review', 'more', 'settings', 'about', 'player', 'reader', 'packs', 'chat', 'podcast'];

function parse(): Route {
  const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return (routes as string[]).includes(name) ? (name as Route) : 'search';
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = (r: Route) => `#/${r}`;
