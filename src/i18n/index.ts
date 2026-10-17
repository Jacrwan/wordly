import type { UiLang } from '../db/schema';
import { en } from './en';
import { ko, type StringKey } from './ko';

export type { StringKey };
export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

const tables: Record<UiLang, Record<StringKey, string>> = { ko, en };

export function makeT(lang: UiLang): Translate {
  const table = tables[lang];
  return (key, vars) => {
    let s = table[key] ?? ko[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}
