/** Verge layout uses 26.6 fixed-point CSS pixels: 64 units per CSS pixel. */
export const CSS_FIXED_SCALE = 64;

export type CssCoordinate = number & { readonly __cssCoordinate: unique symbol };
export type CssPixelLength = number & { readonly __cssPixelLength: unique symbol };

export interface CssPoint {
  readonly x: CssCoordinate;
  readonly y: CssCoordinate;
}

export interface CssSize {
  readonly width: CssPixelLength;
  readonly height: CssPixelLength;
}

export interface CssRect extends CssPoint, CssSize {}

export interface CssEdges {
  readonly top: CssPixelLength;
  readonly right: CssPixelLength;
  readonly bottom: CssPixelLength;
  readonly left: CssPixelLength;
}

const MAX_FIXED = Number.MAX_SAFE_INTEGER;
const MIN_FIXED = Number.MIN_SAFE_INTEGER;

function saturate(value: number): number {
  if (!Number.isFinite(value)) return value < 0 ? MIN_FIXED : MAX_FIXED;
  return Math.max(MIN_FIXED, Math.min(MAX_FIXED, Math.trunc(value)));
}

export function cssPx(value: number): CssPixelLength {
  if (!Number.isFinite(value)) throw new RangeError("CSS pixel value must be finite.");
  return saturate(Math.round(value * CSS_FIXED_SCALE)) as CssPixelLength;
}

export function cssCoordinate(value: CssPixelLength): CssCoordinate {
  return value as number as CssCoordinate;
}

export function cssLengthFromFixed(value: number): CssPixelLength {
  if (!Number.isFinite(value)) throw new RangeError("CSS fixed-point value must be finite.");
  return saturate(value) as CssPixelLength;
}

export function cssCoordinateFromFixed(value: number): CssCoordinate {
  if (!Number.isFinite(value)) throw new RangeError("CSS fixed-point coordinate must be finite.");
  return saturate(value) as CssCoordinate;
}

export function cssAdd(left: CssPixelLength, right: CssPixelLength): CssPixelLength {
  return saturate(left + right) as CssPixelLength;
}

export function cssSubtract(left: CssPixelLength, right: CssPixelLength): CssPixelLength {
  return saturate(left - right) as CssPixelLength;
}

export function cssMultiply(value: CssPixelLength, factor: number): CssPixelLength {
  if (!Number.isFinite(factor)) throw new RangeError("CSS fixed-point multiplier must be finite.");
  return saturate(value * factor) as CssPixelLength;
}

export function cssDivide(value: CssPixelLength, divisor: number): CssPixelLength {
  if (!Number.isFinite(divisor) || divisor === 0) throw new RangeError("CSS fixed-point divisor must be finite and non-zero.");
  return saturate(value / divisor) as CssPixelLength;
}

export function cssMax(...values: readonly CssPixelLength[]): CssPixelLength {
  return (values.length === 0 ? 0 : Math.max(...values)) as CssPixelLength;
}

export function cssMin(...values: readonly CssPixelLength[]): CssPixelLength {
  return (values.length === 0 ? 0 : Math.min(...values)) as CssPixelLength;
}

export function cssRect(
  x: CssCoordinate,
  y: CssCoordinate,
  width: CssPixelLength,
  height: CssPixelLength
): CssRect {
  return Object.freeze({ x, y, width: cssMax(cssPx(0), width), height: cssMax(cssPx(0), height) });
}

export function cssIntersection(left: CssRect, right: CssRect): CssRect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edge = Math.min(left.x + left.width, right.x + right.width);
  const bottom = Math.min(left.y + left.height, right.y + right.height);
  return cssRect(
    cssCoordinateFromFixed(x),
    cssCoordinateFromFixed(y),
    cssLengthFromFixed(Math.max(0, edge - x)),
    cssLengthFromFixed(Math.max(0, bottom - y))
  );
}

export function cssUnion(rectangles: readonly CssRect[], fallback: CssRect): CssRect {
  if (rectangles.length === 0) return fallback;
  const x = Math.min(...rectangles.map((value) => value.x));
  const y = Math.min(...rectangles.map((value) => value.y));
  const edge = Math.max(...rectangles.map((value) => value.x + value.width));
  const bottom = Math.max(...rectangles.map((value) => value.y + value.height));
  return cssRect(
    cssCoordinateFromFixed(x),
    cssCoordinateFromFixed(y),
    cssLengthFromFixed(edge - x),
    cssLengthFromFixed(bottom - y)
  );
}

export function cssPixels(value: CssPixelLength | CssCoordinate): number {
  return value / CSS_FIXED_SCALE;
}
