import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const DAY = 24 * 3600;

/** Map and terrain tiles: keep what's been viewed so those areas work without signal. */
const tiles = (name: string, pattern: RegExp, maxEntries: number) => ({
  urlPattern: pattern,
  handler: 'StaleWhileRevalidate' as const,
  options: {
    cacheName: name,
    expiration: { maxEntries, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true },
    cacheableResponse: { statuses: [200] },
  },
});

export default defineConfig({
  worker: { format: 'es' }, // MapLibre's worker is an ES module
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // the app shows "New version available" rather than reloading under you
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
      manifest: {
        name: 'Weather',
        short_name: 'Weather',
        description: 'Point forecasts for any spot: National Weather Service in the US, Open-Meteo elsewhere.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f9f9f7',
        theme_color: '#2a78d6',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          tiles('map-tiles', /^https:\/\/([abc]\.tile\.opentopomap\.org|basemap\.nationalmap\.gov)\//, 1500),
          tiles('trail-tiles', /^https:\/\/[abc]\.tile-cyclosm\.openstreetmap\.fr\//, 1500),
          tiles('esri-tiles', /^https:\/\/server\.arcgisonline\.com\//, 1000),
          // Outdoors style: vector tiles, fonts and icons from OpenFreeMap.
          tiles('openfreemap', /^https:\/\/tiles\.openfreemap\.org\//, 3000),
          tiles('terrain', /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\//, 200),
          // Trail-condition terrain: elevation tiles never change.
          {
            urlPattern: /\/api\/(dem|soil|canopy)\//,
            handler: 'CacheFirst' as const,
            options: { cacheName: 'dem', expiration: { maxEntries: 800, maxAgeSeconds: 60 * DAY, purgeOnQuotaError: true }, cacheableResponse: { statuses: [200] } },
          },
          // Forecasts are kept by the app itself (src/store.ts) so it knows how old they are.
          // Air quality and place search are live by nature: never served from a stale cache.
        ],
      },
    }),
  ],
});
