import { db } from '../db/schema';
import type { Manifest, Shard } from './types';

// Dictionary shards come from /data (built by scripts/build_dict.py). Each shard is fetched
// on first use and kept in IndexedDB, so words looked up once keep working offline.

const BASE = `${import.meta.env.BASE_URL}data/`;
const MANIFEST_ID = '_manifest';

export type ShardKind = 'dict' | 'ko';

/** Same rule as shard_id() in build_dict.py: first two chars, non a–z → "_". */
export function dictShardId(key: string): string {
  return [...(key + '_').slice(0, 2)].map((c) => (c >= 'a' && c <= 'z' ? c : '_')).join('');
}

/** Same rule as ko_shard() in build_dict.py: initial consonant of the first syllable. */
export function koShardId(key: string): string {
  const c = key.charCodeAt(0);
  return c >= 0xac00 && c <= 0xd7a3 ? String(Math.floor((c - 0xac00) / 588)).padStart(2, '0') : 'xx';
}

let manifestPromise: Promise<Manifest | null> | null = null;

/** The live manifest when online, otherwise the last one we saw. */
export function getManifest(): Promise<Manifest | null> {
  manifestPromise ??= (async () => {
    try {
      const res = await fetch(`${BASE}manifest.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const m: Manifest = await res.json();
      await db.dictShards.put({ shardId: MANIFEST_ID, version: m.version, data: m });
      return m;
    } catch {
      const stored = await db.dictShards.get(MANIFEST_ID);
      return (stored?.data as Manifest) ?? null;
    }
  })();
  return manifestPromise;
}

const memory = new Map<string, Promise<Record<string, unknown> | null>>();

/**
 * Entries of one shard, `{}` if the shard doesn't exist, or `null` if it isn't stored
 * and can't be fetched (offline before first use).
 */
export function loadShard<T>(kind: ShardKind, id: string): Promise<Record<string, T> | null> {
  const key = `${kind}/${id}`;
  let p = memory.get(key);
  if (!p) {
    p = fetchShard(kind, id, key);
    memory.set(key, p);
    // Don't remember failures, so the next lookup retries once the network is back.
    p.then((r) => r === null && memory.delete(key));
  }
  return p as Promise<Record<string, T> | null>;
}

async function fetchShard(kind: ShardKind, id: string, key: string): Promise<Record<string, unknown> | null> {
  const manifest = await getManifest();
  if (manifest && !manifest[kind].includes(id)) return {};
  const stored = await db.dictShards.get(key);
  if (stored && (!manifest || stored.version === manifest.version)) return stored.data as Record<string, unknown>;
  try {
    const res = await fetch(`${BASE}${key}.json`);
    if (!res.ok) throw new Error(String(res.status));
    const shard: Shard<unknown> = await res.json();
    await db.dictShards.put({ shardId: key, version: shard.v, data: shard.e });
    return shard.e;
  } catch {
    // Offline: an older version is better than nothing.
    return (stored?.data as Record<string, unknown>) ?? null;
  }
}

export interface OfflineStatus {
  stored: number;
  total: number;
}

export async function offlineStatus(): Promise<OfflineStatus | null> {
  const manifest = await getManifest();
  if (!manifest) return null;
  const keys = (await db.dictShards.toCollection().primaryKeys()) as string[];
  const current = new Set(keys);
  const wanted = [...manifest.dict.map((s) => `dict/${s}`), ...manifest.ko.map((s) => `ko/${s}`)];
  return { stored: wanted.filter((k) => current.has(k)).length, total: wanted.length };
}

/** Downloads every shard so the whole dictionary works offline. */
export async function downloadAll(onProgress: (done: number, total: number) => void): Promise<boolean> {
  const manifest = await getManifest();
  if (!manifest) return false;
  const jobs: [ShardKind, string][] = [
    ...manifest.ko.map((s) => ['ko', s] as [ShardKind, string]),
    ...manifest.dict.map((s) => ['dict', s] as [ShardKind, string]),
  ];
  let done = 0;
  let ok = true;
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if ((await loadShard(job[0], job[1])) === null) ok = false;
      onProgress(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return ok;
}
