import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://johncabrahams.com',
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
  // Essay footnotes render under a visible "Notes" heading, the way paulgraham.com does it.
  markdown: { remarkRehype: { footnoteLabel: 'Notes' } },
  redirects: { '/projects/khronos': '/projects/kronos' },
});
