import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Essays: one Markdown file per essay in src/content/essays. The filename is the URL slug.
const essays = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/essays' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { essays };
