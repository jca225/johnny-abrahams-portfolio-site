// Who wrote the words on each page, shown as one word at the foot of every page. Keyed by route; a route not listed here gets DEFAULT.
//
//   human: I wrote the prose. AI may have answered questions; it wrote no sentences.
//   ai:    AI (Claude) drafted the prose from my notes, code, and papers; I edited and checked it.
//
// Default is 'ai' on purpose: git shows Claude co-authored every commit that touched these
// pages since April 2026, so a page is only marked 'human' when I say I wrote it.

export type Author = 'human' | 'ai';

export interface Authorship {
  by: Author;
  note?: string;
}

export const LABEL: Record<Author, string> = {
  human: 'Human-written',
  ai: 'AI-drafted',
};

const DEFAULT: Authorship = { by: 'ai' };

// Routes without a trailing slash.
export const PAGES: { path: string; title: string; authorship: Authorship }[] = [
  { path: '/', title: 'Home', authorship: { by: 'ai' } },
  { path: '/projects', title: 'All projects', authorship: { by: 'ai' } },
  { path: '/projects/kronos', title: 'Kronos', authorship: { by: 'ai' } },
  { path: '/projects/research', title: 'Reasoning and Memory in Language Models', authorship: { by: 'ai' } },
  { path: '/projects/gpubox', title: 'gpubox', authorship: { by: 'ai' } },
  { path: '/projects/crowd-aware-music', title: 'Crowd-Aware Music Recommender', authorship: { by: 'ai' } },
  { path: '/projects/capstone-search', title: 'Capstone search', authorship: { by: 'ai' } },
  { path: '/projects/quant-game', title: 'Quant game', authorship: { by: 'ai' } },
  { path: '/projects/therapy-chatbot', title: 'Therapy chatbot', authorship: { by: 'ai' } },
  { path: '/writing', title: 'Writing', authorship: { by: 'ai' } },
  { path: '/essays', title: 'Essays (index)', authorship: { by: 'ai' } },
  {
    path: '/essays/exokernel-philosophy',
    title: 'The Exokernel Philosophy',
    authorship: { by: 'human', note: 'I asked AI questions, mostly to paraphrase facts, never for ideas.' },
  },
  { path: '/resume.pdf', title: 'Resume', authorship: { by: 'ai' } },
];

export function authorshipFor(pathname: string): Authorship {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return PAGES.find((p) => p.path === path)?.authorship ?? DEFAULT;
}
