import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.lm'],
  server: { fs: { allow: ['../..'] } },
});
