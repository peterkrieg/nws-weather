# Weather

A clean point-forecast app built on the [National Weather Service API](https://www.weather.gov/documentation/services-web-api). Search an address or click anywhere on the map (handy for trailheads) to get the NWS forecast for that exact spot.

**Live:** https://nws-weather.pkrieg2.workers.dev

## Features

- Address and place search with autocomplete (also accepts `lat, lon`)
- Current conditions, active NWS alerts, and the 7-day forecast
- Hourly charts with synced hover: temperature, precipitation chance, cloud cover, humidity, rain and snow amounts, wind and gusts
- Map with OpenStreetMap, OpenTopoMap, USGS Topo and a hiking-trails overlay; click to load a forecast
- Ground elevation of the selected point
- Sunrise, sunset, and first/last usable light (civil twilight)
- Shareable URLs, light and dark mode, mobile friendly

## Data sources

| What | Source |
| --- | --- |
| Forecasts and alerts | api.weather.gov |
| Place search | [Photon](https://photon.komoot.io/) (OpenStreetMap data) |
| Elevation | Terrarium terrain tiles (USGS 3DEP in the US) |
| Sun times | Calculated in the browser |

There is no backend: it is a static site that calls these services directly from the browser.

## Stack

React, TypeScript, Vite, Mantine, Recharts, react-leaflet. Hosted on Cloudflare Workers static assets.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck and build to dist/
npm run deploy   # build and deploy to Cloudflare (requires `wrangler login`)
```
