import { setImmediate } from "node:timers/promises";
import { rasterImage, type RasterImage } from "@ismail-elkorchi/terminal-ui";
import type { DocumentImageResource } from "../document/image-resources.js";
import type { TerminalImagePlacement, ViewportCellBuffer } from "../presentation/terminal/index.js";
import type { CssColor } from "../presentation/style/index.js";
import { registerRetainedOwner } from "../memory/retained-cost.js";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
// A decoded buffer owns at most one unchanged opaque handle. Flattened artwork belongs
// to its immutable viewport binding, never to a mutable latest-color cache.
const originals = new WeakMap<Uint8Array, RasterImage>();
interface PreparedImage {
  readonly resource: DocumentImageResource;
  readonly key: string;
  readonly image: RasterImage;
}
interface Presentation {
  readonly images: Map<string, PreparedImage>;
  reservedBytes: number;
  preparing: boolean;
  discarded: boolean;
  sources: readonly DocumentImageResource[];
}
const presentations = new WeakMap<ViewportCellBuffer, Presentation>();
// Strong ownership lasts only until the viewport completion is accepted/rejected.
const pending = new Map<ViewportCellBuffer, Presentation>();

function validResource(resource: DocumentImageResource): resource is Extract<DocumentImageResource, { status: "ready" }> {
  return resource.status === "ready" && typeof resource.hasAlpha === "boolean" && resource.width !== null && resource.height !== null
    && Number.isSafeInteger(resource.width) && resource.width > 0
    && Number.isSafeInteger(resource.height) && resource.height > 0
    && resource.pixels.byteLength <= MAX_SOURCE_BYTES
    && resource.pixels.byteLength === resource.width * resource.height * 4;
}

function makeRaster(width: number, height: number, pixels: Uint8Array): RasterImage {
  const image = rasterImage({ width, height, format: "rgba8", data: pixels }, { sourceBytes: MAX_SOURCE_BYTES });
  registerRetainedOwner(image, [], () => image.byteLength);
  return image;
}

function originalRaster(resource: DocumentImageResource): RasterImage | undefined {
  if (resource.status !== "ready" || resource.hasAlpha) return undefined;
  const image = originals.get(resource.pixels);
  return image?.width === resource.width && image.height === resource.height ? image : undefined;
}

/** Logical owners may change without changing this immutable decoded generation. */
function sameDecodedSource(left: DocumentImageResource, right: DocumentImageResource): boolean {
  return left.status === "ready" && right.status === "ready" && left.id === right.id
    && left.requestUrl === right.requestUrl && left.pixels === right.pixels
    && left.width === right.width && left.height === right.height && left.hasAlpha === right.hasAlpha;
}

function validColor(color: CssColor | null | undefined): color is CssColor {
  return color !== null && color !== undefined && [color.r, color.g, color.b].every((channel) =>
    Number.isFinite(channel) && channel >= 0 && channel <= 255)
    && Number.isFinite(color.a) && color.a >= 0 && color.a <= 1;
}

function presentationKey(resource: DocumentImageResource, placement: TerminalImagePlacement): string | null {
  if (!validResource(resource) || resource.width !== placement.naturalWidth || resource.height !== placement.naturalHeight) return null;
  if (placement.maskTint === undefined && !resource.hasAlpha) return "opaque";
  if (!placement.safeForTransparency || !validColor(placement.compositingBackdrop)
    || placement.compositingBackdrop.a !== 1 || (placement.maskTint !== undefined && !validColor(placement.maskTint))) return null;
  // Known source transparency must have participated in the worker's native-ink
  // protection pass. A stale pre-decode placement cannot gain pixels afterward.
  if (placement.maskTint === undefined && placement.hasAlpha !== resource.hasAlpha) return null;
  return JSON.stringify([placement.compositingBackdrop, placement.maskTint ?? null, placement.sourceInset ?? null, placement.rasterSize ?? null]);
}

/** A read-only view lookup: no scans, pixel copies, handle creation, or fallback guesses. */
export function browserRasterImage(
  resource: DocumentImageResource,
  placement: TerminalImagePlacement,
  viewport: ViewportCellBuffer | undefined,
): RasterImage | null {
  if (viewport === undefined) return null;
  const prepared = presentations.get(viewport)?.images.get(placement.resourceId);
  return prepared !== undefined && sameDecodedSource(prepared.resource, resource) && prepared.key === presentationKey(resource, placement)
    ? prepared.image : null;
}

export function browserResourceImageHandles(resource: DocumentImageResource): readonly RasterImage[] {
  const image = originalRaster(resource);
  return image === undefined ? [] : [image];
}
export function browserViewportImageResources(viewport: ViewportCellBuffer): readonly DocumentImageResource[] {
  return [...(presentations.get(viewport)?.images.values() ?? [])].map((entry) => entry.resource);
}
export function browserViewportImageHandles(viewport: ViewportCellBuffer): readonly RasterImage[] {
  return [...(presentations.get(viewport)?.images.values() ?? [])].map((entry) => entry.image);
}
/** Reservations include flattening workspace and handles not yet allocated. */
export function browserPendingImageAllocations(): { readonly images: readonly RasterImage[]; readonly resources: readonly DocumentImageResource[]; readonly reservedBytes: number } {
  const images: RasterImage[] = [];
  const resources: DocumentImageResource[] = [];
  let reservedBytes = 0;
  for (const owner of pending.values()) {
    reservedBytes += owner.reservedBytes;
    resources.push(...owner.sources);
    for (const prepared of owner.images.values()) { images.push(prepared.image); resources.push(prepared.resource); }
  }
  return { images, resources, reservedBytes };
}
export function acceptBrowserViewportImages(viewport: ViewportCellBuffer): void { pending.delete(viewport); }
/** Rejected candidates never alter an accepted viewport's immutable binding. */
export function discardBrowserViewportImages(viewport: ViewportCellBuffer): void {
  const owner = pending.get(viewport);
  if (owner === undefined) return;
  owner.discarded = true;
  if (owner.preparing) return;
  pending.delete(viewport);
  presentations.delete(viewport);
  owner.images.clear();
  owner.sources = [];
  owner.reservedBytes = 0;
}

function outputGeometry(resource: DocumentImageResource, placement: TerminalImagePlacement): {
  readonly width: number; readonly height: number;
  readonly inset: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
} | null {
  if (resource.width === null || resource.height === null) return null;
  const inset = placement.sourceInset ?? { left: 0, top: 0, width: 1, height: 1 };
  if (![inset.left, inset.top, inset.width, inset.height].every(Number.isFinite)
    || inset.left < 0 || inset.top < 0 || inset.width <= 0 || inset.height <= 0
    || inset.left + inset.width > 1.000001 || inset.top + inset.height > 1.000001) return null;
  const rasterSize = placement.rasterSize;
  if (rasterSize !== undefined && (!Number.isFinite(rasterSize.width) || !Number.isFinite(rasterSize.height)
    || rasterSize.width <= 0 || rasterSize.height <= 0)) return null;
  const padded = inset.left !== 0 || inset.top !== 0 || inset.width !== 1 || inset.height !== 1;
  const width = Math.ceil(Math.max(resource.width / inset.width, padded ? rasterSize?.width ?? 0 : 0));
  const height = Math.ceil(Math.max(resource.height / inset.height, padded ? rasterSize?.height ?? 0 : 0));
  if (!Number.isSafeInteger(width * height * 4) || width * height * 4 > MAX_SOURCE_BYTES) return null;
  return { width, height, inset };
}

/** Called only at the asynchronous render-completion boundary, before admission. */
export async function prepareBrowserViewportImages(
  resources: readonly DocumentImageResource[],
  viewport: ViewportCellBuffer,
  remainingBytes: () => number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (presentations.has(viewport)) return;
  const owner: Presentation = { images: new Map(), reservedBytes: 0, preparing: true, discarded: false, sources: resources };
  presentations.set(viewport, owner);
  pending.set(viewport, owner);
  registerRetainedOwner(viewport, () => [...owner.images.values()].flatMap((entry) => [entry.resource, entry.image]));
  const check = (): void => {
    signal?.throwIfAborted();
    if (owner.discarded) throw new DOMException("Image preparation was superseded.", "AbortError");
  };
  try {
    const sources = new Map(resources.map((resource) => [resource.id, resource]));
    // One selected variant per source per viewport. Conflicting tints/backdrops
    // deliberately keep their semantic fallback rather than grow a color cache.
    for (const placement of viewport.images) {
      check();
      if (owner.images.has(placement.resourceId)) continue;
      const resource = sources.get(placement.resourceId);
      if (resource === undefined || !validResource(resource)) continue;
      const key = presentationKey(resource, placement);
      if (key === null) continue;
      if (key === "opaque") {
        const existing = originalRaster(resource);
        if (existing !== undefined) { owner.images.set(resource.id, { resource, key, image: existing }); continue; }
        // A decoded buffer has one immutable shape. Conflicting metadata cannot
        // grow a sequence of reinterpretations retained by that same buffer.
        if (originals.has(resource.pixels)) continue;
        if (remainingBytes() < resource.pixels.byteLength) continue;
        owner.reservedBytes = resource.pixels.byteLength;
        const image = makeRaster(resource.width as number, resource.height as number, resource.pixels);
        owner.images.set(resource.id, { resource, key, image });
        owner.reservedBytes = 0;
        // Shared original pixels are independent of viewport/backdrop identity.
        originals.set(resource.pixels, image);
        registerRetainedOwner(resource.pixels, [image]);
        continue;
      }
      const geometry = outputGeometry(resource, placement);
      if (geometry === null) continue;
      const bytes = geometry.width * geometry.height * 4;
      // rasterImage clones its input. Both the temporary output and the future
      // library-owned copy are reserved before allocating either one.
      if (remainingBytes() < bytes * 2) continue;
      owner.reservedBytes = bytes * 2;
      const pixels = new Uint8Array(bytes);
      const backdrop = placement.compositingBackdrop as CssColor;
      const tint = placement.maskTint;
      const sourceWidth = resource.width as number, sourceHeight = resource.height as number;
      const { width, height, inset } = geometry;
      for (let row = 0; row < height; row += 1) {
        if ((row & 63) === 0) {
          await setImmediate(undefined, signal === undefined ? undefined : { signal });
          check();
        }
        const sourceY = ((row + 0.5) / height - inset.top) / inset.height;
        for (let column = 0; column < width; column += 1) {
          if (column > 0 && (column & 65535) === 0) {
            await setImmediate(undefined, signal === undefined ? undefined : { signal });
            check();
          }
          const sourceX = ((column + 0.5) / width - inset.left) / inset.width;
          const offset = (row * width + column) * 4;
          const inside = sourceX >= 0 && sourceX < 1 && sourceY >= 0 && sourceY < 1;
          const source = (Math.min(sourceHeight - 1, Math.floor(sourceY * sourceHeight)) * sourceWidth
            + Math.min(sourceWidth - 1, Math.floor(sourceX * sourceWidth))) * 4;
          const alpha = inside ? (resource.pixels[source + 3] ?? 0) / 255 * (tint?.a ?? 1) : 0;
          pixels[offset] = Math.round((tint?.r ?? resource.pixels[source] ?? 0) * alpha + backdrop.r * (1 - alpha));
          pixels[offset + 1] = Math.round((tint?.g ?? resource.pixels[source + 1] ?? 0) * alpha + backdrop.g * (1 - alpha));
          pixels[offset + 2] = Math.round((tint?.b ?? resource.pixels[source + 2] ?? 0) * alpha + backdrop.b * (1 - alpha));
          pixels[offset + 3] = 255;
        }
      }
      check();
      const image = makeRaster(width, height, pixels);
      owner.images.set(resource.id, { resource, key, image });
      // The local scratch buffer becomes unreachable before this async call
      // returns. Its reservation remains until then, including cancellation.
      owner.reservedBytes = bytes;
      await setImmediate(undefined, signal === undefined ? undefined : { signal });
      owner.reservedBytes = 0;
    }
    check();
  } catch (error) {
    owner.discarded = true;
    throw error;
  } finally {
    owner.preparing = false;
    owner.sources = [];
    owner.reservedBytes = 0;
    if (owner.discarded) discardBrowserViewportImages(viewport);
  }
}
