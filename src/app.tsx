import { useEffect, useRef } from 'preact/hooks';
import { Banners, TabBar } from './components/Layout';
import { useRoute } from './router';
import { About } from './screens/About';
import { More } from './screens/More';
import { Placeholder } from './screens/Placeholder';
import { Review } from './screens/Review';
import { Search } from './screens/Search';
import { SettingsScreen } from './screens/Settings';
import { Words } from './screens/Words';

export function App() {
  const route = useRoute();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => scroller.current?.scrollTo(0, 0), [route]);
  return (
    <div class="app">
      <div class="scroller" ref={scroller}>
        {route === 'search' && <Search />}
        {route === 'words' && <Words />}
        {route === 'review' && <Review />}
        {route === 'more' && <More />}
        {route === 'settings' && <SettingsScreen />}
        {route === 'about' && <About />}
        {route === 'player' && <Placeholder title="more.player" step={5} />}
        {route === 'reader' && <Placeholder title="more.reader" step={5} />}
        {route === 'packs' && <Placeholder title="more.packs" step={6} />}
        {route === 'chat' && <Placeholder title="more.chat" step={7} />}
        {route === 'podcast' && <Placeholder title="more.podcast" step={8} />}
      </div>
      <TabBar route={route} />
      <Banners />
    </div>
  );
}
