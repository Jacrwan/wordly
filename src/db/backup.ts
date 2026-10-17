import { db, loadSettings, saveSettings } from './schema';

const FORMAT = 'wordly-backup';
const VERSION = 1;

// Dictionary shards are re-downloadable and podcast audio is too large for JSON,
// so neither is included. The API key is never exported.
const tables = ['myWords', 'cards', 'reviewLogs', 'easyNotes', 'aiEntries', 'packs', 'chats'] as const;
type TableName = (typeof tables)[number];

export interface Backup {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  profile: unknown;
  data: Record<TableName, unknown[]>;
}

export async function createBackup(): Promise<Backup> {
  const data = {} as Record<TableName, unknown[]>;
  await db.transaction('r', tables.map((n) => db[n]), async () => {
    for (const n of tables) data[n] = await db[n].toArray();
  });
  const settings = await loadSettings();
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), profile: settings.profile, data };
}

export function parseBackup(text: string): Backup | null {
  try {
    const b = JSON.parse(text);
    if (b?.format !== FORMAT || typeof b.version !== 'number' || b.version > VERSION || typeof b.data !== 'object') {
      return null;
    }
    return b as Backup;
  } catch {
    return null;
  }
}

// JSON turns Dates into strings; FSRS card rows need them back.
function reviveCard(row: any) {
  const toDate = (v: unknown) => (typeof v === 'string' ? new Date(v) : v);
  const card = row.card && typeof row.card === 'object'
    ? { ...row.card, due: toDate(row.card.due), last_review: toDate(row.card.last_review) }
    : row.card;
  return { ...row, due: toDate(row.due), card };
}

export async function restoreBackup(b: Backup): Promise<number> {
  await db.transaction('rw', tables.map((n) => db[n]), async () => {
    for (const n of tables) {
      const rows = Array.isArray(b.data[n]) ? b.data[n] : [];
      if (!rows.length) continue;
      // reviewLogs use auto-increment ids; drop them so restored logs never collide.
      const prepared = n === 'cards' ? rows.map(reviveCard)
        : n === 'reviewLogs' || n === 'chats' ? rows.map(({ id: _id, ...r }: any) => r)
        : rows;
      await (db[n] as any).bulkPut(prepared);
    }
  });
  if (b.profile && typeof b.profile === 'object') {
    const s = await loadSettings();
    await saveSettings({ ...s, profile: { ...s.profile, ...(b.profile as object) } });
  }
  return Array.isArray(b.data.myWords) ? b.data.myWords.length : 0;
}

// iOS standalone apps can't always follow a download link, so prefer the share sheet.
export async function deliverFile(name: string, text: string): Promise<void> {
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
