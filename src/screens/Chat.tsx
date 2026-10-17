import { useEffect, useRef, useState } from 'preact/hooks';
import { GeminiError } from '../ai/gemini';
import { creditWord, pickTargets, presentTargets, saveChat, takeTurn, type Target, type Turn } from '../chat/chat';
import { SCENARIOS, type Scenario } from '../chat/scenarios';
import { Page } from '../components/Layout';
import { useDictation } from '../hooks/useDictation';
import { href } from '../router';
import { speak } from '../speech/speak';
import { useApp } from '../state';

export function Chat({ scenarioId }: { scenarioId?: string }) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  return scenario ? <ChatSession key={scenario.id} scenario={scenario} /> : <ScenarioPicker />;
}

function ScenarioPicker() {
  const { t, settings } = useApp();
  const lang = settings.uiLang;
  const [targets, setTargets] = useState<Target[] | null>(null);
  useEffect(() => {
    pickTargets().then(setTargets);
  }, []);
  return (
    <Page title={t('more.chat')} back="more">
      <p class="muted small">{t('chat.intro')}</p>
      {targets && targets.length > 0 && (
        <p class="small">{t('chat.targetsPreview')}: <strong lang="en">{targets.map((x) => x.display).join(', ')}</strong></p>
      )}
      {targets && targets.length === 0 && <p class="muted small">{t('chat.noWords')}</p>}
      <div class="scenario-grid">
        {SCENARIOS.map((s) => (
          <a key={s.id} class="card scenario" href={href('chat', s.id)}>
            <span class="scenario-icon" aria-hidden="true">{s.icon}</span>
            <strong>{s.title[lang]}</strong>
            <span class="muted small">{s.desc[lang]}</span>
          </a>
        ))}
      </div>
    </Page>
  );
}

function ChatSession({ scenario }: { scenario: Scenario }) {
  const { t, settings } = useApp();
  const [targets, setTargets] = useState<Target[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [credited, setCredited] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showKo, setShowKo] = useState(settings.profile.level === 'beginner');
  const [autoRead, setAutoRead] = useState(true);
  const [ended, setEnded] = useState(false);
  const chatId = useRef<number | undefined>(undefined);
  const startedAt = useRef(Date.now());
  const bottom = useRef<HTMLDivElement>(null);
  const dictation = useDictation(setInput);

  const say = (text: string) => autoRead && speak(text, 'en-US', settings.speech.rate);

  function failMessage(e: unknown): string {
    if ((e as Error).message === 'unavailable') return t('word.aiUnavailable');
    if (e instanceof GeminiError && e.kind === 'rate-limit') return t('word.aiBusy');
    return t('word.aiError');
  }

  // Gemini opens the scene.
  useEffect(() => {
    let live = true;
    (async () => {
      const picked = await pickTargets();
      if (!live) return;
      setTargets(picked);
      setBusy(true);
      try {
        const r = await takeTurn(scenario, picked, [], null, settings);
        if (!live) return;
        setTurns([{ role: 'model', text: r.reply, ko: r.replyKo, hint: r.hintKo || undefined }]);
        say(r.reply);
      } catch (e) {
        if (live) setError(failMessage(e));
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    dictation.stop();
    setInput('');
    setError('');
    const userTurn: Turn = { role: 'user', text };
    const history = [...turns, userTurn];
    setTurns(history);
    setBusy(true);
    try {
      const [r, present] = await Promise.all([takeTurn(scenario, targets, turns, text, settings), presentTargets(text, targets)]);
      // Credit only words Gemini judged correct AND that really appear in the message, once per chat.
      const used = targets
        .filter((x) => present.has(x.key) && r.usedCorrectly.some((u) => u.toLowerCase() === x.display.toLowerCase() || u.toLowerCase() === x.key))
        .map((x) => x.key)
        .filter((k) => !credited.includes(k));
      for (const k of used) await creditWord(k);
      const done: Turn = {
        ...userTurn,
        credited: used.length ? used : undefined,
        correction: r.correctionBetter ? { original: r.correctionOriginal, better: r.correctionBetter, note: r.correctionNoteKo } : undefined,
      };
      const reply: Turn = { role: 'model', text: r.reply, ko: r.replyKo, hint: r.hintKo || undefined };
      const next = [...turns, done, reply];
      const nowCredited = [...credited, ...used];
      setTurns(next);
      setCredited(nowCredited);
      say(r.reply);
      chatId.current = await saveChat(chatId.current, scenario.id, next, nowCredited, startedAt.current);
    } catch (e) {
      setError(failMessage(e));
      setTurns(turns); // let the learner resend
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  const lang = settings.uiLang;
  const corrections = turns.filter((x) => x.correction).length;

  return (
    <Page title={`${scenario.icon} ${scenario.title[lang]}`} back="chat">
      {targets.length > 0 && (
        <div class="chips target-chips">
          {targets.map((x) => (
            <span key={x.key} class={`chip small-chip ${credited.includes(x.key) ? 'on' : ''}`} lang="en" title={x.ko.join(', ')}>
              {credited.includes(x.key) ? '✓ ' : ''}{x.display}
            </span>
          ))}
        </div>
      )}
      <div class="chat-tools">
        <button class={`chip small-chip ${showKo ? 'on' : ''}`} aria-pressed={showKo} onClick={() => setShowKo(!showKo)}>{t('chat.showKo')}</button>
        <button class={`chip small-chip ${autoRead ? 'on' : ''}`} aria-pressed={autoRead} onClick={() => setAutoRead(!autoRead)}>🔊 {t('chat.autoRead')}</button>
      </div>

      <div class="chat-log">
        {turns.map((m, i) => (m.role === 'model' ? <ModelBubble key={i} turn={m} showKo={showKo} last={i === turns.length - 1} /> : <UserBubble key={i} turn={m} />))}
        {busy && <div class="bubble model typing" aria-label={t('chat.typing')}><span /><span /><span /></div>}
        {error && <p class="status error small">{error}</p>}
        <div ref={bottom} />
      </div>

      {ended ? (
        <section class="card center">
          <h2>{t('chat.summary')}</h2>
          <p>{credited.length ? t('chat.creditedCount', { n: credited.length }) : t('chat.noneCredited')}</p>
          {credited.length > 0 && <p lang="en"><strong>{credited.join(', ')}</strong></p>}
          <p class="muted small">{t('chat.correctionsCount', { n: corrections })}</p>
          <a class="btn primary block" href={href('chat')}>{t('chat.newChat')}</a>
        </section>
      ) : (
        <div class="chat-input">
          <textarea class="input" rows={1} value={input} placeholder={dictation.listening ? t('chat.listening') : t('chat.placeholder')}
            lang="en" autocapitalize="sentences" enterkeyhint="send"
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
          {dictation.supported && (
            <button class={`btn icon-btn mic ${dictation.listening ? 'on' : ''}`} onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
              aria-label={t('chat.mic')}>🎤</button>
          )}
          <button class="btn primary send" disabled={busy || !input.trim()} onClick={send} aria-label={t('chat.send')}>↑</button>
        </div>
      )}
      {dictation.error && <p class="muted tiny">{t('chat.micError', { e: dictation.error })}</p>}
      {!ended && turns.length > 1 && <button class="btn ghost block gap-top" onClick={() => setEnded(true)}>{t('chat.end')}</button>}
    </Page>
  );
}

function ModelBubble({ turn, showKo, last }: { turn: Turn; showKo: boolean; last: boolean }) {
  const { t, settings } = useApp();
  const [hint, setHint] = useState(false);
  return (
    <div class="bubble model">
      <div class="bubble-text" lang="en">{turn.text}</div>
      {showKo && turn.ko && <div class="bubble-ko">{turn.ko}</div>}
      <div class="bubble-actions">
        <button class="btn link small" onClick={() => speak(turn.text, 'en-US', settings.speech.rate)}>🔊 {t('word.listen')}</button>
        {last && turn.hint && !hint && <button class="btn link small" onClick={() => setHint(true)}>💡 {t('chat.hint')}</button>}
      </div>
      {last && hint && turn.hint && <div class="bubble-hint">💡 {turn.hint}</div>}
    </div>
  );
}

function UserBubble({ turn }: { turn: Turn }) {
  const { t } = useApp();
  return (
    <div class="user-turn">
      <div class="bubble user" lang="en">{turn.text}</div>
      {turn.correction && (
        <div class="correction">
          <div class="small">{t('chat.better')}</div>
          <div lang="en"><s>{turn.correction.original}</s> → <strong>{turn.correction.better}</strong></div>
          {turn.correction.note && <div class="small muted">{turn.correction.note}</div>}
        </div>
      )}
      {turn.credited && (
        <div class="credited">
          {turn.credited.map((k) => <span key={k} class="chip small-chip on" lang="en">✓ {k} · {t('chat.reviewed')}</span>)}
        </div>
      )}
    </div>
  );
}
