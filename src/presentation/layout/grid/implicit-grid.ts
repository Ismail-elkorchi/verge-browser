import type { CssGridAutoTrackList, CssGridTrackSizingFunction } from "../../style/index.js";
import type { ExpandedGridAxis, GridTrackSequence } from "./types.js";

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function buildGridTrackSequence(
  explicit: ExpandedGridAxis,
  minimumLine: number,
  maximumLine: number,
  implicit: CssGridAutoTrackList,
  occupiedExplicitTracks: ReadonlySet<number> = new Set()
): GridTrackSequence {
  const tracks: CssGridTrackSizingFunction[] = [];
  for (let line = minimumLine; line < maximumLine; line += 1) {
    if (line >= 0 && line < explicit.tracks.length) {
      const sizing = explicit.tracks[line];
      if (sizing === undefined) throw new RangeError("Explicit Grid track sequence is inconsistent.");
      tracks.push(sizing);
    } else {
      const sequenceIndex = line < 0
        ? modulo(line, implicit.length)
        : modulo(line - explicit.tracks.length, implicit.length);
      const sizing = implicit[sequenceIndex];
      if (sizing === undefined) throw new RangeError("Implicit Grid track sequence must not be empty.");
      tracks.push(sizing);
    }
  }
  const offset = -minimumLine;
  const collapsed = new Set<number>();
  for (const track of explicit.autoFitTracks) {
    if (!occupiedExplicitTracks.has(track)) collapsed.add(track + offset);
  }
  return Object.freeze({
    tracks: Object.freeze(tracks),
    explicitTrackOffset: offset,
    collapsedTracks: collapsed
  });
}
