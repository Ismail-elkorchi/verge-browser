import type { CssLength } from "../types.js";

export type CssGridTrackBreadth =
  | { readonly kind: "length"; readonly value: CssLength }
  | { readonly kind: "auto" | "min-content" | "max-content" }
  | { readonly kind: "flex"; readonly factor: number };

export type CssGridTrackSizingFunction =
  | { readonly kind: "breadth"; readonly breadth: CssGridTrackBreadth }
  | {
      readonly kind: "minmax";
      readonly minimum: CssGridTrackBreadth;
      readonly maximum: CssGridTrackBreadth;
    }
  | { readonly kind: "fit-content"; readonly limit: CssLength };

export interface CssGridLineNames {
  readonly kind: "line-names";
  readonly names: readonly string[];
}

export interface CssGridTrackEntry {
  readonly kind: "track";
  readonly sizing: CssGridTrackSizingFunction;
}

export interface CssGridRepeatEntry {
  readonly kind: "repeat";
  readonly repetition:
    | { readonly kind: "fixed"; readonly count: number }
    | { readonly kind: "auto-fill" | "auto-fit" };
  readonly entries: readonly (CssGridLineNames | CssGridTrackEntry)[];
}

export type CssGridTrackListEntry = CssGridLineNames | CssGridTrackEntry | CssGridRepeatEntry;

export type CssGridTrackList =
  | { readonly kind: "none" }
  | { readonly kind: "track-list"; readonly entries: readonly CssGridTrackListEntry[] };

export type CssGridAutoTrackList = readonly CssGridTrackSizingFunction[];

export interface CssGridAreaBounds {
  readonly name: string;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

export type CssGridTemplateAreas =
  | { readonly kind: "none" }
  | {
      readonly kind: "areas";
      readonly rows: readonly (readonly (string | null)[])[];
      readonly areas: ReadonlyMap<string, CssGridAreaBounds>;
    };

export interface CssGridTemplate {
  readonly columns: CssGridTrackList;
  readonly rows: CssGridTrackList;
  readonly areas: CssGridTemplateAreas;
}

export type CssGridLine =
  | { readonly kind: "auto" }
  | {
      readonly kind: "line";
      readonly span: boolean;
      readonly index: number | null;
      readonly name: string | null;
    };

export interface CssGridPlacement {
  readonly columnStart: CssGridLine;
  readonly columnEnd: CssGridLine;
  readonly rowStart: CssGridLine;
  readonly rowEnd: CssGridLine;
}

export interface CssGridAutoFlow {
  readonly axis: "row" | "column";
  readonly packing: "sparse" | "dense";
}

export const GRID_AUTO_LINE: CssGridLine = Object.freeze({ kind: "auto" });
export const GRID_NONE_TRACK_LIST: CssGridTrackList = Object.freeze({ kind: "none" });
export const GRID_NONE_AREAS: CssGridTemplateAreas = Object.freeze({ kind: "none" });
export const GRID_AUTO_TRACKS: CssGridAutoTrackList = Object.freeze([
  Object.freeze({ kind: "breadth", breadth: Object.freeze({ kind: "auto" }) })
]);
