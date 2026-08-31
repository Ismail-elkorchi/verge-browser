import { GridWorkBudgetExceeded, type GridAreaPlacement } from "./types.js";

export class SparseGridOccupancy {
  readonly #rows = new Map<number, { start: number; end: number }[]>();
  readonly #limit: number;
  #intervals = 0;

  public constructor(limit: number) {
    this.#limit = limit;
  }

  public vacant(
    rowStart: number,
    rowEnd: number,
    columnStart: number,
    columnEnd: number,
    consume: () => void
  ): boolean {
    for (let row = rowStart; row < rowEnd; row += 1) {
      consume();
      for (const interval of this.#rows.get(row) ?? []) {
        consume();
        if (columnStart < interval.end && columnEnd > interval.start) return false;
      }
    }
    return true;
  }

  public occupy(item: GridAreaPlacement, consume: () => void): void {
    for (let row = item.rowStart; row < item.rowEnd; row += 1) {
      consume();
      const intervals = this.#rows.get(row) ?? [];
      let insertion = 0;
      while (insertion < intervals.length && (intervals[insertion]?.end ?? item.columnStart) < item.columnStart) {
        consume();
        insertion += 1;
      }
      let start = item.columnStart;
      let end = item.columnEnd;
      let removed = 0;
      while (insertion + removed < intervals.length) {
        consume();
        const interval = intervals[insertion + removed];
        if (interval === undefined || interval.start > end) break;
        start = Math.min(start, interval.start);
        end = Math.max(end, interval.end);
        removed += 1;
      }
      const intervalIncrease = removed === 0 ? 1 : 1 - removed;
      if (intervalIncrease > this.#limit - this.#intervals) {
        throw new GridWorkBudgetExceeded("maxGridOccupancyIntervals", this.#limit);
      }
      intervals.splice(insertion, removed, { start, end });
      this.#rows.set(row, intervals);
      this.#intervals += intervalIncrease;
    }
  }

  public get intervals(): number { return this.#intervals; }
}
