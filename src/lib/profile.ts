import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

const file = path.resolve(process.cwd(), 'profile/profile.yaml');
export const profile: any = load(fs.readFileSync(file, 'utf8'));

function pick(id: string): any {
  const byId = Object.fromEntries(profile.experience.map((e: any) => [e.id, e]));
  const limits = profile.resume.bullet_limit ?? {};
  const e = { ...byId[id] };
  const sel = limits[id];
  if (typeof sel === 'number') e.bullets = e.bullets.slice(0, sel);
  else if (Array.isArray(sel)) e.bullets = sel.map((k: number) => e.bullets[k]);
  return e;
}

/** Resume sections (Experience / Research / Projects) with bullet selection applied. */
export function resumeSections(): { title: string; items: any[] }[] {
  const sections = profile.resume.sections ??
    [{ title: 'Experience', ids: profile.resume.experience_order }];
  return sections.map((s: any) => ({ title: s.title, items: s.ids.map(pick) }));
}

/** Flat list of resume entries in resume order (kept for callers that want one list). */
export function resumeExperience(): any[] {
  return resumeSections().flatMap((s) => s.items);
}
