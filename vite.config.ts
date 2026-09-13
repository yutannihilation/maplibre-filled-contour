import {defineConfig} from 'vite';

// MapLibre GL JS 6's worker is imported with `?worker&url` in demo/main.ts,
// so Vite handles it through the module-worker pipeline without extra aliases.
export default defineConfig({});
