# maplibre-filled-contour

Generate filled contour (isoband) [MapLibre Tiles (MLT)](https://maplibre.org/maplibre-tile-spec/) in the browser from Terrarium or Mapbox Terrain-RGB tiles.

The plugin fetches and caches the requested DEM tile and its neighbors, decodes elevations, constructs seamless isoband polygons, encodes them as MLT, and serves them to MapLibre through a custom protocol. Polygon generation can run in a module worker to keep the main thread responsive.

## Prior work

The API and browser-side DEM pipeline build on [maplibre-contour](https://github.com/onthegomap/maplibre-contour). This project adapts that prior work to generate filled isobands and encode them as MLT for MapLibre GL JS 6.

## Use

```js
import * as filledContour from 'maplibre-filled-contour';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// Vite must bundle MapLibre 6's module worker and provide its emitted URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const demSource = new filledContour.DemSource({
  url: 'https://url/of/dem/source/{z}/{x}/{y}.png',
  // Produces [100, 200), [200, 300), and [300, infinity).
  // The band below 100 is intentionally omitted.
  thresholds: [100, 200, 300],
  encoding: 'terrarium', // "terrarium" (default) or "mapbox"
  maxzoom: 13,
  worker: true,
  cacheSize: 100,
  timeoutMs: 10_000
});

// Register protocols before constructing the map so MapLibre's workers know them.
demSource.setupMaplibre(maplibregl);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json'
});

map.on('load', () => {
  map.addSource('filled-contours', demSource.getSourceSpecification());

  map.addLayer({
    id: 'filled-contours',
    type: 'fill',
    source: 'filled-contours',
    'source-layer': demSource.layer, // "isobands" by default
    paint: {
      'fill-color': [
        'match', ['get', 'min'],
        100, '#d8f3dc',
        200, '#74c69d',
        300, '#1b4332',
        '#000000'
      ],
      'fill-opacity': 0.72
    }
  });
});
```

Every polygon has these properties:

- `band`: zero-based band index
- `min`: inclusive lower threshold
- `max`: exclusive upper threshold, omitted for the final unbounded band

The default source layer is `isobands`. Override it with the constructor's `layer` option. `extent` defaults to 4096 and `buffer` defaults to one vector-tile unit.

## Reuse decoded DEM tiles

The same cache can supply a MapLibre terrain or hillshade source:

```js
map.addSource('dem', {
  type: 'raster-dem',
  encoding: 'terrarium',
  tiles: [demSource.sharedDemProtocolUrl],
  tileSize: 256,
  maxzoom: 13
});
```

Call `demSource.destroy()` when the source is no longer needed. It clears all caches, terminates its worker, and unregisters its protocols where MapLibre exposes `removeProtocol`.

## MapLibre 6 worker setup

MapLibre GL JS 6 loads its worker as a separate ES module. Configure its URL before creating a map when using a bundler:

- Vite: import `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and pass the result to `setWorkerUrl()`, as shown above. Plain `?url` is insufficient for production because it does not bundle the worker's shared module.
- webpack 5, Rspack, or Rsbuild: `maplibregl.setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString())`.
- Direct browser ESM from a CDN: no call is normally required because MapLibre 6 detects the worker relative to its own module URL.

This is separate from the `worker` option on `DemSource`, which controls the plugin's isoband-computation worker. Set it to `false` only when you deliberately want contour generation on the main thread.

## Development

```sh
pnpm install
pnpm test
pnpm check
pnpm build
pnpm demo
```
