import type {ControlPosition, IControl, Map} from 'maplibre-gl';
import type {IsobandBand, IsobandLegendOptions} from './types.js';

/** MapLibre control that renders the same bands and colors used by the fill layer. */
export class IsobandLegendControl implements IControl {
    private readonly bands: readonly IsobandBand[];
    private readonly options: IsobandLegendOptions;
    private container: HTMLElement | undefined;

    constructor(bands: readonly IsobandBand[], options: IsobandLegendOptions = {}) {
        this.bands = bands.map((band) => ({...band}));
        this.options = options;
    }

    readonly getDefaultPosition = (): ControlPosition => this.options.position ?? 'bottom-left';

    onAdd(_map: Map): HTMLElement {
        const container = document.createElement('div');
        container.className = ['maplibregl-ctrl', 'maplibre-filled-contour-legend', this.options.className]
            .filter(Boolean).join(' ');
        container.setAttribute('role', 'group');
        const title = this.options.title === undefined ? 'Elevation' : this.options.title;
        container.setAttribute(
            'aria-label',
            this.options.ariaLabel ?? (title === false ? 'Contour legend' : title)
        );
        Object.assign(container.style, {
            background: 'var(--maplibre-filled-contour-legend-background, rgba(255, 255, 255, 0.94))',
            borderRadius: 'var(--maplibre-filled-contour-legend-border-radius, 4px)',
            boxShadow: 'var(--maplibre-filled-contour-legend-box-shadow, 0 1px 2px rgba(0, 0, 0, 0.1))',
            boxSizing: 'border-box',
            color: 'var(--maplibre-filled-contour-legend-color, #1f2937)',
            font: 'var(--maplibre-filled-contour-legend-font, 12px/1.35 sans-serif)',
            maxWidth: 'var(--maplibre-filled-contour-legend-max-width, calc(100vw - 20px))',
            minWidth: 'var(--maplibre-filled-contour-legend-min-width, 140px)',
            width: 'var(--maplibre-filled-contour-legend-width, max-content)',
            padding: 'var(--maplibre-filled-contour-legend-padding, 10px 12px)'
        });

        if (title !== false) {
            const heading = document.createElement('div');
            heading.className = 'maplibre-filled-contour-legend__title';
            heading.textContent = title;
            Object.assign(heading.style, {
                fontWeight: 'var(--maplibre-filled-contour-legend-title-weight, 700)',
                marginBottom: 'var(--maplibre-filled-contour-legend-title-spacing, 7px)'
            });
            container.append(heading);
        }

        const list = document.createElement('div');
        list.className = 'maplibre-filled-contour-legend__items';
        Object.assign(list.style, {
            display: 'grid',
            gap: 'var(--maplibre-filled-contour-legend-row-gap, 4px)'
        });
        for (const band of this.bands) list.append(this.createItem(band));
        container.append(list);
        this.container = container;
        return container;
    }

    onRemove(_map: Map): void {
        this.container?.remove();
        this.container = undefined;
    }

    private createItem(band: IsobandBand): HTMLElement {
        const item = document.createElement('div');
        item.className = 'maplibre-filled-contour-legend__item';
        Object.assign(item.style, {
            alignItems: 'center',
            display: 'flex',
            gap: 'var(--maplibre-filled-contour-legend-item-gap, 7px)'
        });

        const swatch = document.createElement('span');
        swatch.className = 'maplibre-filled-contour-legend__swatch';
        swatch.setAttribute('aria-hidden', 'true');
        Object.assign(swatch.style, {
            backgroundColor: band.color,
            border: 'var(--maplibre-filled-contour-legend-swatch-border, 1px solid rgba(0, 0, 0, 0.12))',
            borderRadius: 'var(--maplibre-filled-contour-legend-swatch-border-radius, 2px)',
            flex: '0 0 var(--maplibre-filled-contour-legend-swatch-size, 14px)',
            height: 'var(--maplibre-filled-contour-legend-swatch-size, 14px)'
        });

        const label = document.createElement('span');
        label.className = 'maplibre-filled-contour-legend__label';
        label.textContent = this.options.formatLabel?.(band) ?? this.formatRange(band);
        label.style.whiteSpace = 'var(--maplibre-filled-contour-legend-white-space, nowrap)';
        item.append(swatch, label);
        return item;
    }

    private formatRange(band: IsobandBand): string {
        const format = this.options.formatValue ?? defaultFormatValue;
        const unit = this.options.unit ? ` ${this.options.unit}` : '';
        if (band.min === undefined) return `< ${format(band.max as number)}${unit}`;
        if (band.max === undefined) return `≥ ${format(band.min)}${unit}`;
        return `${format(band.min)}–${format(band.max)}${unit}`;
    }
}

const numberFormatter = new Intl.NumberFormat(undefined, {maximumFractionDigits: 2});

function defaultFormatValue(value: number): string {
    return numberFormatter.format(value);
}
