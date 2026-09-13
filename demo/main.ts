import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {DemSource} from '../src/index.ts';
import './style.css';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const demSource = new DemSource({
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    thresholds: [0, 250, 500, 1000, 1500, 2000, 3000],
    colors: [
        '#f1f8e9',
        '#dcedc8',
        '#aed581',
        '#7cb342',
        '#558b2f',
        '#6d4c41',
        '#eceff1'
    ],
    encoding: 'terrarium',
    maxzoom: 13,
    cacheSize: 100,
    timeoutMs: 10_000,
    includeLower: false,
    includeUpper: true
});
demSource.setupMaplibre(maplibregl);

const map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [138.1, 36.3],
    zoom: 6
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
map.on('load', () => {
    demSource.addTo(map, {
        sourceId: 'filled-contours',
        id: 'filled-contours',
        paint: {
            'fill-opacity': 0.76,
            'fill-outline-color': 'rgba(45, 55, 35, 0.18)'
        },
        legend: {
            title: 'Elevation',
            unit: 'm',
            position: 'bottom-left'
        }
    });
});

map.on('error', (event) => console.error('MapLibre demo error', event.error));
