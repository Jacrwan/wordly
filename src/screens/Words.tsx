import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Layout';
import { db } from '../db/schema';
import { useApp } from '../state';

export function Words() {
  const { t } = useApp();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    db.myWords.count().then(setCount);
  }, []);
  return (
    <Page title={t('words.title')}>
      {count === 0 && <p class="muted center">{t('words.empty')}</p>}
    </Page>
  );
}
