import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under peterkrieg.com/weather/, so the built files live in dist/weather.
export default defineConfig({
  plugins: [react()],
  base: '/weather/',
  build: { outDir: 'dist/weather', emptyOutDir: true },
});
