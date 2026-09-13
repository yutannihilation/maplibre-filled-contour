# Isoband polygon generation across MLT tiles

## Current model

This plugin does not construct one global polygon dataset and slice it with
`geojson-vt`. It generates every requested tile directly from the raster DEM at
the same zoom level:

```text
DEM tile plus 8 neighbors
            |
            v
decode RGB elevations and build a padded corner-sample grid
            |
            v
D3 cumulative contours for every threshold
            |
            v
subtract adjacent contours to make disjoint isobands
            |
            v
clip, scale, and round into tile-local integer coordinates
            |
            v
encode Polygon features with @maplibre/mlt encodeTile
```

MapLibre still receives each result as an independent vector tile. There is no
cross-tile polygon identity or geometry reconstruction.

## Band semantics

For strictly increasing thresholds `t0, t1, ..., tn`, `d3-contour` first
produces cumulative polygons `C(i)` containing values greater than or equal to
`ti`. The implementation converts them into non-overlapping bands with
`polygon-clipping`:

```text
band -1 = clip - C(0)  = (-infinity, t0) (when `lower` is true)
band 0  = C(0) - C(1) = [t0, t1)
band 1 = C(1) - C(2) = [t1, t2)
...
band n = C(n)          = [tn, infinity) (when `upper` is true)
```

By default, `lower` is false and `upper` is true. For `thresholds: [100, 200,
300]`, the default output is therefore `[100, 200)`, `[200, 300)`, and `[300,
infinity)`. Set `lower: true` to include `(-infinity, 100)`, and set `upper:
false` to omit `[300, infinity)`.

Every emitted feature has numeric properties:

- `band`: threshold index; the lower unbounded band uses `-1`
- `min`: inclusive lower threshold; omitted from the lower unbounded band
- `max`: exclusive upper threshold; omitted from the final unbounded band

A band that has no geometry in a tile emits no feature.

## Building a tile-continuous elevation grid

`DemSource` fetches the requested DEM tile and its eight neighbors. Horizontal
tile coordinates wrap across the antimeridian. Neighbor rows beyond the north
or south edge of the XYZ pyramid are absent and contribute no valid samples.

Terrarium and Mapbox Terrain-RGB pixels are decoded to metres. Non-finite values
and elevations outside `[-12000, 9000]` are changed to `NaN` before contouring.
The input pixels represent samples at pixel centres; `HeightTile.toGrid()` turns
them into corner samples by averaging the available four adjacent pixel values.
This is the grid convention expected by the contour generator.

The corner grid is materialized with two extra samples on every side. Because
those samples come from the same neighboring DEM tiles used by adjacent output
tiles, both tiles contour shared boundary data instead of inventing unrelated
edge values. D3 smoothing uses linear interpolation between grid samples.

This neighbor overlap, rather than a persistent global polygon index, is the
mechanism used to keep contour intersections consistent across tile edges.

## Clipping and tile coordinates

Each cumulative contour is initially expressed in coordinates of the padded
sample grid. After adjacent contours are subtracted, the resulting geometry is
intersected with the owning tile's rectangle plus `buffer`.

`extent` defaults to `4096`. `buffer` defaults to `1` and is measured in those
vector-tile coordinate units, so the default encoded range can extend from
`-1` to `4097` on either axis. The clipped coordinates are transformed to the
MLT extent and rounded to integers.

The small buffer moves artificial clipping edges outside the visible tile.
MapLibre renders and stencil-clips each vector tile independently, so adjacent
pieces appear continuous when their shared DEM samples, interpolation, and
style agree. MapLibre does not union the pieces.

This has several practical consequences:

- Do not simplify or alter individual output tiles independently after
  generation; doing so can move shared boundary intersections and expose seams.
- `fill-outline-color` is drawn from each tile's own rings. A non-zero buffer
  keeps most clip-created closing edges behind the tile stencil.
- Queries and measurements operate on tile-local pieces, not on one merged
  isoband covering the map.
- Increasing `buffer` expands only the encoded polygon area. It does not fetch
  more than the existing 3-by-3 DEM neighborhood.

## MLT representation

[`encodeIsobandTile`](../src/mlt.ts) calls `encodeTile` from `@maplibre/mlt`.
The encoded tile contains one feature table whose name is `layer` (`isobands` by
default) and whose extent is the configured `extent`.

D3 and `polygon-clipping` return a `MultiPolygon` for a band. The implementation
emits each polygon component as a separate MLT `Polygon` feature and retains its
interior rings as holes. It does not emit one `MultiPolygon` feature, and it does
not assign feature ids. All components copy the band's `band` and whichever of
the optional `min` and `max` boundaries apply.

Before encoding, the implementation removes a repeated closing coordinate and
consecutive duplicate coordinates from every ring. Ring closure and polygon
topology are represented by the MLT geometry rather than by repeating the first
coordinate at the end.

`DemSource.getSourceSpecification()` exposes the generated tiles as:

```js
{
  type: 'vector',
  tiles: ['<id>-isobands://{z}/{x}/{y}.mlt'],
  minzoom: 0,
  maxzoom,
  encoding: 'mlt'
}
```

The `encoding: 'mlt'` member selects MapLibre GL JS 6's MLT decoder. The plugin
does not generate MVT/PBF tiles.

## Protocols, caching, and workers

`setupMaplibre()` registers two custom protocols:

- `<id>-isobands://` generates and returns MLT isoband tiles.
- `<id>-shared://` returns the original raster bytes so a MapLibre `raster-dem`
  source can share DEM requests with contour generation.

There are three independent asynchronous LRU caches, each with the configured
`cacheSize`: raw raster responses, decoded elevation tiles, and encoded MLT
tiles. Concurrent consumers of the same cache key share in-flight work. The
`timeoutMs` limit applies to the raw DEM fetch. Cache-control and expiry headers
are forwarded by the shared-raster protocol when the upstream response provides
them.

When `worker` is true and the browser provides `Worker`, the materialized
`Float32Array` is transferred to one lazily created module worker. Isoband
generation, polygon Boolean operations, and MLT encoding then run in that
worker. Otherwise the same `processTile()` function runs on the main thread.
Aborting a consumer stops waiting for its worker result, but does not interrupt
a calculation already executing inside the worker.

`destroy()` clears all three caches, aborts their outstanding suppliers,
terminates the plugin worker, and unregisters both protocols when MapLibre
provides `removeProtocol()`.

## Implementation map

- [`DemSource` and protocol orchestration](../src/dem-source.ts)
- [DEM decoding](../src/decode-image.ts)
- [Neighbor and corner-grid handling](../src/height-tile.ts)
- [Cumulative contours, band subtraction, and clipping](../src/isobands.ts)
- [MLT feature construction and encoding](../src/mlt.ts)
- [Worker entry point](../src/worker.ts)

## Upstream references

- [D3 contour polygons](https://d3js.org/d3-contour/contour)
- [`polygon-clipping` Boolean operations](https://github.com/mfogel/polygon-clipping)
- [MapLibre Tile specification](https://maplibre.org/maplibre-tile-spec/)
- [MapLibre GL JS MLT source implementation](https://github.com/maplibre/maplibre-gl-js/blob/main/src/source/vector_tile_mlt.ts)
- [MapLibre GL JS rendering architecture](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md#how-vector-tile-rendering-works)
