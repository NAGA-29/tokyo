import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5280 },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
