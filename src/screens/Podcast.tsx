import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Target } from '../chat/chat';
import { Icon } from '../components/Icon';
import { Page } from '../components/Layout';
import { db, type Level, type Podcast as Episode } from '../db/schema';
import { useLive } from '../hooks/useLive';
import type { StringKey } from '../i18n';
import { createEpisode, episodeAudio, HOSTS, jobState, onJob, podcastWords, resetJob, type Script } from '../podcast/podcast';
import { go, href } from '../router';
import { setMediaSession, SpeechQueue, type QueueState, type Segment } from '../speech/engine';
import { useApp } from '../state';
import { Sheet } from './Reader';
import { WordPanel } from './Word';
import { SpeedLoop, Transport } from './Player';

const LEVELS: Level[] = ['beginner', 'intermediate', 'advanced'];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Podcast({ id }: { id?: string }) {
  return id ? <EpisodeScreen key={id} id={Number(id)} /> : <PodcastHome />;
}

function useJob() {
  const [, force] = useState(0);
  useEffect(() => onJob(() => force((n) => n + 1)), []);
  return jobState();
}

function PodcastHome() {
  const { t, settings } = useApp();
  const job = useJob();
  const [level, setLevel] = useState<Level>(settings.profile.level);
  const [words, setWords] = useState<Target[] | null>(null);
  const episodes = useLive(() => db.podcasts.orderBy('createdAt').reverse().toArray(), []);

  useEffect(() => {
    podcastWords().then(setWords);
  }, []);
  useEffect(() => {
    if (job.status === 'done') {
      const id = job.id;
      resetJob();
      go('podcast', String(id));
    }
  }, [job.status]);

  const working = job.status === 'script' || job.status === 'audio';
  const errorText = job.status === 'error'
    ? job.message === 'unavailable' ? t('word.aiUnavailable')
      : job.message === 'few-words' ? t('podcast.fewWords')
      : job.message === 'busy' ? t('word.aiBusy')
      : t('word.aiError')
    : '';

  return (
    <Page title={t('more.podcast')} back="more">
      <section class="card">
        <h2>{t('podcast.new')}</h2>
        <div class="field">
          <span>{t('podcast.level')}</span>
          <div class="segmented">
            {LEVELS.map((l) => (
              <button key={l} class={level === l ? 'on' : ''} aria-pressed={level === l} disabled={working} onClick={() => setLevel(l)}>
                {t(`level.${l}` as StringKey)}
              </button>
            ))}
          </div>
          <p class="muted small flush">{t(`podcast.levelHelp.${level}` as StringKey)}</p>
        </div>
        {words && words.length > 0 && (
          <p class="small">{t('podcast.words', { n: words.length })}: <span lang="en">{words.map((w) => w.display).join(', ')}</span></p>
        )}
        {working ? (
          <div class="podcast-progress">
            <progress class="progress" max={job.status === 'audio' ? job.total + 1 : 1} value={job.status === 'audio' ? job.done + 1 : 0.15} />
            <p class="small">{job.status === 'script' ? t('podcast.writing') : t('podcast.voicing', { done: job.done + 1, total: job.total })}</p>
            <p class="muted tiny">{t('podcast.background')}</p>
          </div>
        ) : (
          <button class="btn primary block" onClick={() => createEpisode(settings, level)}>{t('podcast.create')}</button>
        )}
        {errorText && <p class="status error small">{errorText}</p>}
      </section>

      {episodes && episodes.length > 0 && (
        <>
          <h2 class="section-title">{t('podcast.episodes')}</h2>
          <ul class="list pack-list">
            {episodes.map((ep) => {
              const script = ep.script as Script;
              return (
                <li key={ep.id}>
                  <a href={href('podcast', String(ep.id))}>
                    <span class="pack-icon" aria-hidden="true">🎙️</span>
                    <span class="wl-main">
                      <span class="wl-word">{ep.title}</span>
                      <span class="tiny muted">
                        {new Date(ep.createdAt).toLocaleDateString(settings.uiLang === 'ko' ? 'ko-KR' : 'en-US')} · {t(`level.${ep.level}` as StringKey)}
                        {script.duration ? ` · ${fmt(script.duration)}` : ''} · {ep.audioSource === 'gemini' ? t('podcast.aiVoice') : t('podcast.deviceVoice')}
                      </span>
                    </span>
                    <Icon name="chevron" size={20} />
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- episode

function EpisodeScreen({ id }: { id: number }) {
  const { t } = useApp();
  const ep = useLive(() => db.podcasts.get(id), [id]) as Episode | undefined | null;
  const [lookup, setLookup] = useState<string | null>(null);
  if (ep === undefined) return <Page title={t('more.podcast')} back="podcast"><p class="muted center">{t('word.loading')}</p></Page>;
  if (!ep) return <Page title={t('more.podcast')} back="podcast"><p class="muted center">{t('podcast.missing')}</p></Page>;
  const script = ep.script as Script;

  return (
    <Page title={ep.title} back="podcast">
      {ep.audio ? (
        <AudioEpisode ep={ep} script={script} onWord={setLookup} />
      ) : (
        <SpeechEpisode ep={ep} script={script} onWord={setLookup} />
      )}
      <button class="btn ghost danger block gap-top" onClick={async () => {
        if (confirm(t('podcast.deleteConfirm'))) {
          await db.podcasts.delete(id);
          go('podcast');
        }
      }}>{t('podcast.delete')}</button>
      {lookup && (
        <Sheet onClose={() => setLookup(null)}>
          <WordPanel query={lookup} source="podcast" />
        </Sheet>
      )}
    </Page>
  );
}

function AudioEpisode({ ep, script, onWord }: { ep: Episode; script: Script; onWord: (w: string) => void }) {
  const { t, settings } = useApp();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(settings.speech.rate);
  const duration = script.duration ?? 0;

  useEffect(() => {
    let live = true;
    episodeAudio(ep).then((blob) => live && setUrl(URL.createObjectURL(blob)), () => live && setUrl(URL.createObjectURL(ep.audio!)));
    return () => {
      live = false;
    };
  }, [ep.id]);

  useEffect(() => {
    if (!url) return;
    const el = new Audio(url);
    el.preload = 'auto';
    audio.current = el;
    el.ontimeupdate = () => setTime(el.currentTime);
    el.onplay = () => setPlaying(true);
    el.onpause = el.onended = () => setPlaying(false);
    setMediaSession(ep.title, {
      play: () => el.play(),
      pause: () => el.pause(),
      next: () => (el.currentTime = Math.min(el.duration || duration, el.currentTime + 15)),
      prev: () => (el.currentTime = Math.max(0, el.currentTime - 15)),
    });
    return () => {
      el.pause();
      URL.revokeObjectURL(url);
    };
  }, [url]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  const current = script.timing ? script.timing.findIndex(([a, b]) => time >= a && time < b) : -1;
  const seek = (s: number) => audio.current && (audio.current.currentTime = Math.max(0, Math.min(duration, s)));

  return (
    <>
      <section class="card podcast-player">
        <input class="seek" type="range" min="0" max={duration} step="0.5" value={time}
          onInput={(e) => seek(Number(e.currentTarget.value))} aria-label={t('podcast.position')} />
        <div class="seek-times small muted"><span>{fmt(time)}</span><span>{fmt(duration)}</span></div>
        <Transport playing={playing} onPrev={() => seek(time - 15)} onToggle={() => (playing ? audio.current?.pause() : audio.current?.play())}
          onNext={() => seek(time + 15)} />
        <SpeedLoop rate={rate} onRate={setRate} loop={false} onLoop={() => {}} hideLoop />
        <p class="muted tiny center">{t('podcast.lockOk')}</p>
      </section>
      <Transcript script={script} words={ep.words} current={current} follow={playing} onWord={onWord} onLine={(i) => script.timing && seek(script.timing[i][0])} />
    </>
  );
}

const HANGUL_RUN = /([가-힣][가-힣\s\d.,!?'"~·()…:;-]*)/;

function SpeechEpisode({ ep, script, onWord }: { ep: Episode; script: Script; onWord: (w: string) => void }) {
  const { t, settings } = useApp();
  const queue = useMemo(() => new SpeechQueue(), []);
  const [st, setSt] = useState<QueueState>(queue.state);
  const [rate, setRate] = useState(settings.speech.rate);

  useEffect(() => {
    const segs: Segment[] = [];
    script.lines.forEach((l, g) => {
      // Korean and English parts get their own voices; the second host uses another English voice.
      for (const part of l.text.split(HANGUL_RUN).map((p) => p.trim()).filter((p) => /[\p{L}\p{N}]/u.test(p))) {
        segs.push({ kind: 'say', text: part, lang: /[가-힣]/.test(part) ? 'ko-KR' : 'en-US', group: g, alt: l.speaker === 'B' });
      }
      segs.push({ kind: 'pause', ms: 350, group: g });
    });
    queue.onChange = setSt;
    queue.load(segs);
    setMediaSession(ep.title, { play: () => queue.play(), pause: () => queue.pause(), next: () => queue.nextGroup(), prev: () => queue.prevGroup() });
    return () => queue.stop();
  }, [ep.id]);
  useEffect(() => {
    queue.rate = rate;
  }, [rate]);

  return (
    <>
      <section class="card podcast-player">
        <p class="muted small center">{t('podcast.deviceNote')}</p>
        <Transport playing={st.playing} onPrev={() => queue.prevGroup()} onToggle={() => queue.toggle()} onNext={() => queue.nextGroup()} />
        <SpeedLoop rate={rate} onRate={setRate} loop={false} onLoop={() => {}} hideLoop />
      </section>
      <Transcript script={script} words={ep.words} current={st.playing || st.index > 0 ? st.group : -1} follow={st.playing}
        onWord={onWord} onLine={(i) => queue.jumpToGroup(i)} />
    </>
  );
}

/** Spellings each saved word may take in the script (applies, applied, applying…) → its key. */
function formsMatcher(keys: string[]): { re: RegExp; keyOf: Map<string, string> } | null {
  const keyOf = new Map<string, string>();
  for (const k of keys) {
    const [head, ...rest] = k.split(' ');
    const tail = rest.length ? ' ' + rest.join(' ') : '';
    const heads = [head, head + 's', head + 'es', head + 'ed', head + 'd', head + 'ing'];
    if (head.endsWith('e')) heads.push(head.slice(0, -1) + 'ing');
    if (head.endsWith('y')) heads.push(head.slice(0, -1) + 'ies', head.slice(0, -1) + 'ied');
    heads.forEach((h) => keyOf.set(h + tail, k));
  }
  if (!keyOf.size) return null;
  const alt = [...keyOf.keys()].sort((a, b) => b.length - a.length).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return { re: new RegExp(`\\b(${alt})\\b`, 'gi'), keyOf };
}

function Transcript({ script, words, current, follow, onWord, onLine }: {
  script: Script;
  words: string[];
  current: number;
  follow: boolean;
  onWord: (w: string) => void;
  onLine: (i: number) => void;
}) {
  const { t } = useApp();
  const matcher = useMemo(() => formsMatcher(words), [words.join('|')]);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    if (follow && current >= 0) refs.current[current]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [current, follow]);

  return (
    <section class="card transcript">
      <h3>{t('podcast.transcript')}</h3>
      <ol class="lines">
        {script.lines.map((l, i) => (
          <li key={i} ref={(el) => { refs.current[i] = el; }} class={`line ${l.speaker} ${i === current ? 'current' : ''}`} onClick={() => onLine(i)}>
            <span class="speaker">{HOSTS[l.speaker]}</span>
            <span class="line-text">
              {matcher
                ? l.text.split(matcher.re).map((part, j) =>
                    j % 2 === 1 ? (
                      <button key={j} class="saved-word" lang="en"
                        onClick={(e) => { e.stopPropagation(); onWord(matcher.keyOf.get(part.toLowerCase()) ?? part.toLowerCase()); }}>
                        {part}
                      </button>
                    ) : (
                      <Fragment key={j}>{part}</Fragment>
                    ),
                  )
                : l.text}
            </span>
          </li>
        ))}
      </ol>
      <p class="muted tiny">{t('podcast.tapHint')}</p>
    </section>
  );
}
