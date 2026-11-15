import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Generates the app icons in public/ from public/icon.svg: `npx pwa-assets-generator`.
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    // Full-bleed sky on every icon: iOS and Android round the corners themselves.
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: { background: '#2a78d6' } },
    apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: { background: '#2a78d6' } },
    transparent: { ...minimal2023Preset.transparent, padding: 0 },
  },
  images: ['public/icon.svg'],
});
