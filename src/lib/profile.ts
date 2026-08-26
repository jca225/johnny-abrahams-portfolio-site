import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

const file = path.resolve(process.cwd(), 'profile/profile.yaml');
export const profile: any = load(fs.readFileSync(file, 'utf8'));

/** Experience entries in resume order with resume bullet selection applied. */
export function resumeExperience(): any[] {
  const byId = Object.fromEntries(profile.experience.map((e: any) => [e.id, e]));
  const limits = profile.resume.bullet_limit ?? {};
  return profile.resume.experience_order.map((id: string) => {
    const e = { ...byId[id] };
    const sel = limits[id];
    if (typeof sel === 'number') e.bullets = e.bullets.slice(0, sel);
    else if (Array.isArray(sel)) e.bullets = sel.map((k: number) => e.bullets[k]);
    return e;
  });
}
