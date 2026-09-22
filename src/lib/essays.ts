import { getCollection } from 'astro:content';

/** Published essays, newest first. */
export async function publishedEssays() {
  const all = await getCollection('essays', (e) => !e.data.draft);
  return all.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

/** "September 2026", the way paulgraham.com dates essays. */
export function essayDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
