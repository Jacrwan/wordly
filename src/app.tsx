import { useEffect, useRef } from 'preact/hooks';
import { Banners, TabBar } from './components/Layout';
import { useRoute } from './router';
import { About } from './screens/About';
import { AudioTest } from './screens/AudioTest';
import { Chat } from './screens/Chat';
import { Packs, PackScreen } from './screens/Packs';
import { Player } from './screens/Player';
import { Reader } from './screens/Reader';
import { More } from './screens/More';
import { Placeholder } from './screens/Placeholder';
import { Review } from './screens/Review';
import { Search } from './screens/Search';
import { SettingsScreen } from './screens/Settings';
import { WordScreen } from './screens/Word';
import { Words } from './screens/Words';

export function App() {
  const { name: route, param } = useRoute();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => scroller.current?.scrollTo(0, 0), [route, param]);
  return (
    <div class="app">
      <div class="scroller" ref={scroller}>
        {route === 'search' && <Search />}
        {route === 'word' && param && <WordScreen key={param} query={param} />}
        {route === 'words' && <Words />}
        {route === 'review' && <Review />}
        {route === 'more' && <More />}
        {route === 'settings' && <SettingsScreen />}
        {route === 'about' && <About />}
        {route === 'player' && <Player />}
        {route === 'reader' && <Reader />}
        {route === 'audiotest' && <AudioTest />}
        {route === 'packs' && <Packs />}
        {route === 'pack' && param && <PackScreen key={param} id={param} />}
        {route === 'chat' && <Chat key={param ?? 'picker'} scenarioId={param} />}
        {route === 'podcast' && <Placeholder title="more.podcast" step={8} />}
      </div>
      <TabBar route={route} />
      <Banners />
    </div>
  );
}
