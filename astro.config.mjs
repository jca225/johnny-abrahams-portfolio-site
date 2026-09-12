import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://johncabrahams.com',
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
  redirects: { '/projects/khronos': '/projects/kronos' },
});
