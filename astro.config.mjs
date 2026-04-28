import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  site: 'https://johncabrahams.com',
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
  integrations: [react()],
});
