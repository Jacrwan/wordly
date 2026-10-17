import type { UiLang } from '../db/schema';

const ko: Record<string, string> = {
  noun: '명사', verb: '동사', adj: '형용사', adv: '부사', prep: '전치사', conj: '접속사', pron: '대명사',
  intj: '감탄사', det: '한정사', article: '관사', num: '수사', name: '고유명사', phrase: '구',
  prep_phrase: '전치사구', particle: '불변화사', contraction: '축약형', abbrev: '약어', symbol: '기호',
  suffix: '접미사', prefix: '접두사', proverb: '속담',
};

const en: Record<string, string> = { adj: 'adjective', adv: 'adverb', prep: 'preposition', conj: 'conjunction',
  pron: 'pronoun', intj: 'interjection', det: 'determiner', num: 'numeral', prep_phrase: 'prepositional phrase',
  abbrev: 'abbreviation', name: 'proper noun' };

export function posLabel(p: string, lang: UiLang): string {
  return (lang === 'ko' ? ko[p] : en[p]) ?? p.replace(/_/g, ' ');
}
