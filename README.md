# maplibre-filled-contour

Generate filled contour (isoband) [MapLibre Tiles (MLT)](https://maplibre.org/maplibre-tile-spec/) in the browser from Terrarium or Mapbox Terrain-RGB tiles.

The plugin fetches and caches the requested DEM tile and its neighbors, decodes elevations, constructs seamless isoband polygons, encodes them as MLT, and serves them to MapLibre through a custom protocol. Polygon generation runs in a module worker when available to keep the main thread responsive.

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
  colors: ['#d8f3dc', '#74c69d', '#1b4332'],
  encoding: 'terrarium', // "terrarium" (default) or "mapbox"
  maxzoom: 13,
  cacheSize: 100,
  timeoutMs: 10_000,
  includeLower: false, // Omit [-infinity, 100); this is the default.
  includeUpper: true   // Include [300, infinity); this is the default.
});

// Register protocols before constructing the map so MapLibre's workers know them.
demSource.setupMaplibre(maplibregl);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json'
});

map.on('load', () => {
  demSource.addTo(map, {
    sourceId: 'filled-contours',
    id: 'filled-contours',
    paint: {
      'fill-opacity': 0.72
    },
    legend: {
      title: 'Elevation',
      unit: 'm',
      position: 'bottom-left'
    }
  });
});
```

> **Note:** `colors` is optional. If omitted, the plugin generates a
> single-hue sequential blue ramp sized to the number of emitted bands.

`addTo()` adds the vector source, generated fill layer, and legend together. It must
be called after the map's style has loaded. The returned handle removes everything
it added:

```js
const added = demSource.addTo(map, options);
added.remove();
```

The constructor's optional `colors` setting accepts either one color per emitted
band or a function receiving a normalized position, band index, and total band
count. This makes color interpolators such as those from `d3-scale-chromatic`
usable without adding them as a required dependency:

```js
import {interpolateTerrain} from 'd3-scale-chromatic';

const demSource = new filledContour.DemSource({
  url: 'https://url/of/dem/source/{z}/{x}/{y}.png',
  thresholds: [100, 200, 300],
  colors: interpolateTerrain
});

demSource.addTo(map, {
  sourceId: 'filled-contours',
  id: 'filled-contours',
  legend: {title: 'Elevation', unit: 'm'}
});
```

For manual composition, use `getLayerSpecification()`,
`getFillColorExpression()`, `getBands()`, and `getLegendControl()`. All of them
reuse the colors configured on the source:

```js
map.addSource('filled-contours', demSource.getSourceSpecification());
map.addLayer(demSource.getLayerSpecification({
  id: 'filled-contours',
  source: 'filled-contours',
  paint: {'fill-opacity': 0.72}
}));
map.addControl(demSource.getLegendControl({
  title: 'Elevation',
  unit: 'm'
}));
```

The generated expression matches the always-present `band` property. When
`colors` is omitted, the plugin generates a single-hue blue ramp that works with
any band count. An explicit color array must contain exactly one entry for every
emitted band; mismatches are rejected when `DemSource` is constructed.

### Customizing the legend with CSS

Use the legend's `className` option to give a particular legend a styling hook:

```js
demSource.addTo(map, {
  sourceId: 'filled-contours',
  id: 'filled-contours',
  legend: {
    title: 'Elevation',
    unit: 'm',
    className: 'elevation-legend'
  }
});
```

The built-in appearance is exposed through CSS custom properties. Set only the
values that need to differ:

```css
.elevation-legend {
  --maplibre-filled-contour-legend-background: rgb(24 30 42 / 92%);
  --maplibre-filled-contour-legend-color: white;
  --maplibre-filled-contour-legend-font: 13px/1.4 system-ui, sans-serif;
  --maplibre-filled-contour-legend-min-width: 120px;
  --maplibre-filled-contour-legend-padding: 12px 14px;
  --maplibre-filled-contour-legend-border-radius: 8px;
  --maplibre-filled-contour-legend-box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
  --maplibre-filled-contour-legend-title-weight: 600;
  --maplibre-filled-contour-legend-title-spacing: 8px;
  --maplibre-filled-contour-legend-row-gap: 5px;
  --maplibre-filled-contour-legend-item-gap: 8px;
  --maplibre-filled-contour-legend-swatch-size: 16px;
  --maplibre-filled-contour-legend-swatch-border: 1px solid rgb(255 255 255 / 35%);
  --maplibre-filled-contour-legend-swatch-border-radius: 3px;
}
```

The width-related variables are
`--maplibre-filled-contour-legend-width`,
`--maplibre-filled-contour-legend-min-width`, and
`--maplibre-filled-contour-legend-max-width`. Labels do not wrap by default;
set `--maplibre-filled-contour-legend-white-space: normal` to allow wrapping.

For styling beyond the custom properties, the control exposes these stable
classes:

- `.maplibre-filled-contour-legend`
- `.maplibre-filled-contour-legend__title`
- `.maplibre-filled-contour-legend__items`
- `.maplibre-filled-contour-legend__item`
- `.maplibre-filled-contour-legend__swatch`
- `.maplibre-filled-contour-legend__label`

Every polygon has these properties:

- `band`: zero-based index in the configured output-band sequence
- `min`: inclusive lower threshold, omitted for the lower unbounded band
- `max`: exclusive upper threshold, omitted for the final unbounded band

Set `includeLower: true` to include the band below the first threshold, or `includeUpper: false` to omit the band above the final threshold. The default source layer is `isobands`. Override it with the constructor's `layer` option. `extent` defaults to 4096 and `buffer` defaults to one vector-tile unit.

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

This is separate from the plugin's isoband-computation worker. The plugin starts its worker lazily and automatically falls back to main-thread computation when web workers are unavailable or the worker cannot start.

## Development

```sh
pnpm install
pnpm test
pnpm check
pnpm build
pnpm demo
```
