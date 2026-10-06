import type { TerminalCellRect, TerminalImagePlacement } from "./types.js";

function subtract(rect: TerminalCellRect, cover: TerminalCellRect): readonly TerminalCellRect[] {
  const top = Math.max(rect.row, cover.row), left = Math.max(rect.column, cover.column);
  const bottom = Math.min(rect.row + rect.height, cover.row + cover.height);
  const right = Math.min(rect.column + rect.width, cover.column + cover.width);
  if (top >= bottom || left >= right) return [rect];
  const parts: TerminalCellRect[] = [];
  if (top > rect.row) parts.push({ ...rect, height: top - rect.row });
  if (bottom < rect.row + rect.height) parts.push({ ...rect, row: bottom, height: rect.row + rect.height - bottom });
  if (left > rect.column) parts.push({ row: top, column: rect.column, width: left - rect.column, height: bottom - top });
  if (right < rect.column + rect.width) parts.push({ row: top, column: right, width: rect.column + rect.width - right, height: bottom - top });
  return parts;
}

/** Native editors paint their complete allocation, including otherwise empty cells. */
export function imageClipsAboveControls(
  images: readonly TerminalImagePlacement[],
  controls: readonly { readonly visible: TerminalCellRect; readonly paintGroup: number }[],
  limit: number,
  signal?: AbortSignal,
): { readonly images: readonly TerminalImagePlacement[]; readonly truncated: boolean } {
  const projected: TerminalImagePlacement[] = [];
  for (const image of images) {
    signal?.throwIfAborted();
    let clips = [image.clip];
    for (const control of controls) {
      signal?.throwIfAborted();
      if (control.paintGroup <= image.paintGroup && image.hasAlpha !== true) continue;
      const next: TerminalCellRect[] = [];
      for (const clip of clips) {
        const parts = subtract(clip, control.visible);
        if (projected.length + next.length + parts.length > limit) {
          return { images: Object.freeze(projected), truncated: true };
        }
        next.push(...parts);
      }
      clips = next;
      if (clips.length === 0) break;
    }
    for (const [index, clip] of clips.entries()) {
      if (projected.length >= limit) return { images: Object.freeze(projected), truncated: true };
      projected.push(Object.freeze({ ...image, id: `${image.id}:native:${String(index)}`, clip: Object.freeze(clip) }));
    }
  }
  return { images: Object.freeze(projected), truncated: false };
}
