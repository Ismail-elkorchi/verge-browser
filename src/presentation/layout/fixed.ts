/** Verge layout uses 26.6 fixed-point CSS pixels: 64 units per CSS pixel. */
export const CSS_FIXED_SCALE = 64;

export type CssCoordinate = number & { readonly __cssCoordinate: unique symbol };
export type CssPixelLength = number & { readonly __cssPixelLength: unique symbol };
export type CssNonNegativeLength = CssPixelLength & { readonly __cssNonNegativeLength: unique symbol };

export interface CssPoint {
  readonly x: CssCoordinate;
  readonly y: CssCoordinate;
}

export interface CssSize {
  readonly width: CssNonNegativeLength;
  readonly height: CssNonNegativeLength;
}

export interface CssRect extends CssPoint, CssSize {}

export interface CssEdges {
  readonly top: CssNonNegativeLength;
  readonly right: CssNonNegativeLength;
  readonly bottom: CssNonNegativeLength;
  readonly left: CssNonNegativeLength;
}

export interface CssSignedEdges {
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

function requireSafeFixed(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe fixed-point integer.`);
  }
}

function saturatedAdd(left: number, right: number): number {
  requireSafeFixed(left, "Left CSS fixed-point operand");
  requireSafeFixed(right, "Right CSS fixed-point operand");
  if (right > 0 && left > MAX_FIXED - right) return MAX_FIXED;
  if (right < 0 && left < MIN_FIXED - right) return MIN_FIXED;
  return left + right;
}

function saturatedSubtract(left: number, right: number): number {
  requireSafeFixed(left, "Left CSS fixed-point operand");
  requireSafeFixed(right, "Right CSS fixed-point operand");
  if (right < 0 && left > MAX_FIXED + right) return MAX_FIXED;
  if (right > 0 && left < MIN_FIXED + right) return MIN_FIXED;
  return left - right;
}

function saturatedMultiply(value: number, factor: number): number {
  requireSafeFixed(value, "CSS fixed-point multiplicand");
  if (!Number.isFinite(factor)) throw new RangeError("CSS fixed-point multiplier must be finite.");
  if (value === 0 || factor === 0) return 0;
  const magnitude = Math.abs(factor);
  if (magnitude > MAX_FIXED / Math.abs(value)) {
    return Math.sign(value) === Math.sign(factor) ? MAX_FIXED : MIN_FIXED;
  }
  return Math.trunc(value * factor);
}

export function cssPx(value: number): CssPixelLength {
  if (!Number.isFinite(value)) throw new RangeError("CSS pixel value must be finite.");
  if (value > MAX_FIXED / CSS_FIXED_SCALE) return MAX_FIXED as CssPixelLength;
  if (value < MIN_FIXED / CSS_FIXED_SCALE) return MIN_FIXED as CssPixelLength;
  return Math.round(value * CSS_FIXED_SCALE) as CssPixelLength;
}

export function cssCoordinate(value: CssPixelLength): CssCoordinate {
  requireSafeFixed(value, "CSS fixed-point coordinate");
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

export function cssNonNegativeLength(value: CssPixelLength): CssNonNegativeLength {
  requireSafeFixed(value, "CSS fixed-point length");
  return Math.max(0, value) as CssNonNegativeLength;
}

export function cssAdd(left: CssPixelLength, right: CssPixelLength): CssPixelLength {
  return saturatedAdd(left, right) as CssPixelLength;
}

export function cssSubtract(left: CssPixelLength, right: CssPixelLength): CssPixelLength {
  return saturatedSubtract(left, right) as CssPixelLength;
}

export function cssMultiply(value: CssPixelLength, factor: number): CssPixelLength {
  return saturatedMultiply(value, factor) as CssPixelLength;
}

export function cssNegate(value: CssPixelLength): CssPixelLength {
  return saturatedMultiply(value, -1) as CssPixelLength;
}

export function cssDivide(value: CssPixelLength, divisor: number): CssPixelLength {
  if (!Number.isFinite(divisor) || divisor === 0) throw new RangeError("CSS fixed-point divisor must be finite and non-zero.");
  requireSafeFixed(value, "CSS fixed-point dividend");
  if (value === 0) return 0 as CssPixelLength;
  if (Math.abs(divisor) < Math.abs(value) / MAX_FIXED) {
    return Math.sign(value) === Math.sign(divisor)
      ? MAX_FIXED as CssPixelLength
      : MIN_FIXED as CssPixelLength;
  }
  return Math.trunc(value / divisor) as CssPixelLength;
}

export function cssMax(...values: readonly CssPixelLength[]): CssPixelLength {
  let maximum = 0;
  let initialized = false;
  for (const value of values) {
    requireSafeFixed(value, "CSS fixed-point maximum operand");
    if (!initialized || value > maximum) maximum = value;
    initialized = true;
  }
  return maximum as CssPixelLength;
}

export function cssMin(...values: readonly CssPixelLength[]): CssPixelLength {
  let minimum = 0;
  let initialized = false;
  for (const value of values) {
    requireSafeFixed(value, "CSS fixed-point minimum operand");
    if (!initialized || value < minimum) minimum = value;
    initialized = true;
  }
  return minimum as CssPixelLength;
}

export function cssCoordinateAdd(coordinate: CssCoordinate, offset: CssPixelLength): CssCoordinate {
  return saturatedAdd(coordinate, offset) as CssCoordinate;
}

export function cssCoordinateSubtract(coordinate: CssCoordinate, offset: CssPixelLength): CssCoordinate {
  return saturatedSubtract(coordinate, offset) as CssCoordinate;
}

export function cssCoordinateDifference(end: CssCoordinate, start: CssCoordinate): CssPixelLength {
  return saturatedSubtract(end, start) as CssPixelLength;
}

export function cssRect(
  x: CssCoordinate,
  y: CssCoordinate,
  width: CssPixelLength,
  height: CssPixelLength
): CssRect {
  requireSafeFixed(x, "CSS rectangle x coordinate");
  requireSafeFixed(y, "CSS rectangle y coordinate");
  requireSafeFixed(width, "CSS rectangle width");
  requireSafeFixed(height, "CSS rectangle height");
  return Object.freeze({
    x,
    y,
    width: cssNonNegativeLength(width),
    height: cssNonNegativeLength(height)
  });
}

export function cssIntersection(left: CssRect, right: CssRect): CssRect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edge = Math.min(
    cssCoordinateAdd(left.x, left.width),
    cssCoordinateAdd(right.x, right.width)
  );
  const bottom = Math.min(
    cssCoordinateAdd(left.y, left.height),
    cssCoordinateAdd(right.y, right.height)
  );
  return cssRect(
    cssCoordinateFromFixed(x),
    cssCoordinateFromFixed(y),
    cssMax(cssPx(0), cssLengthFromFixed(saturatedSubtract(edge, x))),
    cssMax(cssPx(0), cssLengthFromFixed(saturatedSubtract(bottom, y)))
  );
}

export function cssUnion(rectangles: Iterable<CssRect>, fallback: CssRect): CssRect {
  let x: number = fallback.x;
  let y: number = fallback.y;
  let edge: number = saturatedAdd(fallback.x, fallback.width);
  let bottom: number = saturatedAdd(fallback.y, fallback.height);
  let initialized = false;
  for (const rectangle of rectangles) {
    const rectangleEdge = saturatedAdd(rectangle.x, rectangle.width);
    const rectangleBottom = saturatedAdd(rectangle.y, rectangle.height);
    if (!initialized) {
      x = rectangle.x;
      y = rectangle.y;
      edge = rectangleEdge;
      bottom = rectangleBottom;
      initialized = true;
      continue;
    }
    if (rectangle.x < x) x = rectangle.x;
    if (rectangle.y < y) y = rectangle.y;
    if (rectangleEdge > edge) edge = rectangleEdge;
    if (rectangleBottom > bottom) bottom = rectangleBottom;
  }
  if (!initialized) return fallback;
  return cssRect(
    cssCoordinateFromFixed(x),
    cssCoordinateFromFixed(y),
    cssMax(cssPx(0), cssLengthFromFixed(saturatedSubtract(edge, x))),
    cssMax(cssPx(0), cssLengthFromFixed(saturatedSubtract(bottom, y)))
  );
}

export function cssPixels(value: CssPixelLength | CssCoordinate): number {
  requireSafeFixed(value, "CSS fixed-point value");
  return value / CSS_FIXED_SCALE;
}

export function isSafeCssFixedValue(value: number): boolean {
  return Number.isSafeInteger(value);
}
