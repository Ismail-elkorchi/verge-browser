import { rasterImage, type RasterImage } from "@ismail-elkorchi/terminal-ui";
import type { DocumentImageResource } from "../document/image-resources.js";
import { registerRetainedOwner } from "../memory/retained-cost.js";

// Handles cannot cross a structured-clone boundary: terminal-ui owns their pixels
// in a private WeakMap. The accepted page resource owns this one UI-side copy.
const handles = new WeakMap<DocumentImageResource, RasterImage | null>();
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

/** Completion-boundary admission; decoding has already rejected nonopaque sources. */
export function prepareBrowserImage(resource: DocumentImageResource): void {
  if (handles.has(resource) || resource.status !== "ready") return;
  let image: RasterImage | null = null;
  const { width, height, pixels } = resource;
  if (width !== null && height !== null && Number.isSafeInteger(width) && width > 0
    && Number.isSafeInteger(height) && height > 0 && pixels.byteLength <= MAX_SOURCE_BYTES
    && pixels.byteLength === width * height * 4) {
    image = rasterImage({ width, height, format: "rgba8", data: pixels }, { sourceBytes: MAX_SOURCE_BYTES });
    // The library's private pixel owner cannot be discovered by object traversal.
    registerRetainedOwner(image, [], () => image?.byteLength ?? 0);
    registerRetainedOwner(resource, [image]);
  }
  handles.set(resource, image);
}

/** Paint is allocation-free with respect to pixels and never constructs a handle. */
export function browserRasterImage(resource: DocumentImageResource): RasterImage | null {
  return handles.get(resource) ?? null;
}
