import type {DemTile} from './types.js';

const MIN_VALID_ELEVATION = -12_000;
const MAX_VALID_ELEVATION = 9_000;

/** A lazily transformed elevation grid. */
export class HeightTile {
    constructor(
        readonly width: number,
        readonly height: number,
        readonly get: (x: number, y: number) => number
    ) {}

    static fromDem(tile: DemTile): HeightTile {
        return new HeightTile(tile.width, tile.height, (x, y) => {
            const value = tile.data[y * tile.width + x];
            return value !== undefined && Number.isFinite(value) &&
                value >= MIN_VALID_ELEVATION && value <= MAX_VALID_ELEVATION
                ? value
                : Number.NaN;
        });
    }

    /** Combines `[nw, n, ne, w, center, e, sw, s, se]` into a seamless virtual tile. */
    static combineNeighbors(neighbors: Array<HeightTile | undefined>): HeightTile | undefined {
        if (neighbors.length !== 9) throw new Error('Expected the center tile and its eight neighbors.');
        const center = neighbors[4];
        if (!center) return undefined;
        return new HeightTile(center.width, center.height, (inputX, inputY) => {
            let x = inputX;
            let y = inputY;
            let column = 1;
            let row = 1;
            if (x < 0) { x += center.width; column = 0; }
            else if (x >= center.width) { x -= center.width; column = 2; }
            if (y < 0) { y += center.height; row = 0; }
            else if (y >= center.height) { y -= center.height; row = 2; }
            return neighbors[row * 3 + column]?.get(x, y) ?? Number.NaN;
        });
    }

    /** Converts pixel-centre samples into corner samples by averaging adjacent pixels. */
    toGrid(): HeightTile {
        return new HeightTile(this.width + 1, this.height + 1, (x, y) => {
            let total = 0;
            let count = 0;
            for (let iy = y - 1; iy <= y; iy++) {
                for (let ix = x - 1; ix <= x; ix++) {
                    const value = this.get(ix, iy);
                    if (Number.isFinite(value)) { total += value; count++; }
                }
            }
            return count ? total / count : Number.NaN;
        });
    }

    /** Copies a grid plus padding into a transferable row-major array. */
    materialize(padding: number): DemTile {
        const width = this.width + padding * 2;
        const height = this.height + padding * 2;
        const data = new Float32Array(width * height);
        let index = 0;
        for (let y = -padding; y < this.height + padding; y++) {
            for (let x = -padding; x < this.width + padding; x++) data[index++] = this.get(x, y);
        }
        return {width, height, data};
    }
}
