import { documentImageMetadata, type DocumentImageMetadata, type DocumentImageResource, type DocumentNodeRef } from "../document/index.js";
import { cssIntersection } from "../presentation/layout/index.js";
import type { ViewportDisplayList } from "../presentation/terminal/types.js";
import { MAX_MASK_URL_CODE_UNITS } from "../presentation/style/mask-values.js";
import { DEFAULT_IMAGE_POLICY } from "./image-policy.js";
import type { IndexedPageSnapshot } from "./types.js";

export interface ViewportImageDiscovery {
  readonly resources: readonly DocumentImageMetadata[];
  readonly omittedReferences: number;
}

/** Viewport priority consumes only already queried, clipped paint candidates,
 * including pending masks with no decoded intrinsics.
 * Two bounded temporary queues give both visible media kinds useful admission;
 * these contain metadata only and are discarded with the viewport operation. */
export function discoverViewportImages(viewport: ViewportDisplayList, signal?: AbortSignal): ViewportImageDiscovery {
  const { viewportRect } = viewport;
  const queues = [new Map<string, { readonly requestUrl: string; readonly owners: Set<DocumentNodeRef> }>(),
    new Map<string, { readonly requestUrl: string; readonly owners: Set<DocumentNodeRef> }>()] as const;
  let omittedReferences = 0;
  let firstKind: 0 | 1 | undefined;
  for (const command of viewport.commands) {
    signal?.throwIfAborted();
    if (command.kind !== "image" || !command.style.visible || command.documentNode === null) continue;
    // The spatial query already intersects translated local ink into clipRect.
    const visible = cssIntersection(cssIntersection(command.rect, command.clipRect), viewportRect);
    if (visible.width <= 0 || visible.height <= 0) continue;
    const requestUrl = command.resourceId, owner = command.documentNode;
    const kind = command.maskTint === undefined ? 0 : 1;
    firstKind ??= kind;
    const queue = queues[kind];
    const existing = queue.get(requestUrl);
    if (existing !== undefined) {
      if (existing.owners.size < 128) existing.owners.add(owner);
      else omittedReferences += 1;
    } else if (queue.size < DEFAULT_IMAGE_POLICY.maxResources) {
      queue.set(requestUrl, { requestUrl, owners: new Set([owner]) });
    } else omittedReferences += 1;
  }
  const ordered = [queues[firstKind ?? 0].values(), queues[firstKind === 1 ? 0 : 1].values()];
  const resources = new Map<string, DocumentImageMetadata>();
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const queue of ordered) {
      const next = queue.next();
      if (next.done) continue;
      remaining = true;
      const value = next.value;
      const previous = resources.get(value.requestUrl);
      if (previous !== undefined) {
        resources.set(value.requestUrl, Object.freeze({ ...previous,
          owners: Object.freeze([...new Set([...previous.owners, ...value.owners])].slice(0, 128)) }));
      } else if (resources.size < DEFAULT_IMAGE_POLICY.maxResources) {
        resources.set(value.requestUrl, Object.freeze({ id: value.requestUrl, requestUrl: value.requestUrl,
          owners: Object.freeze([...value.owners]), width: null, height: null, hasAlpha: null }));
      } else omittedReferences += 1;
    }
  }
  return Object.freeze({ resources: Object.freeze([...resources.values()]), omittedReferences });
}

function validStyleImage(candidate: DocumentImageMetadata): boolean {
  if (candidate.id !== candidate.requestUrl || candidate.requestUrl.length > MAX_MASK_URL_CODE_UNITS
    || candidate.owners.length === 0 || candidate.owners.length > 128) return false;
  try {
    const url = new URL(candidate.requestUrl);
    return ["http:", "https:", "data:"].includes(url.protocol) && url.href === candidate.requestUrl
      && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0;
  } catch { return false; }
}

/** One active bounded URL pool shared by img and CSS artwork. Visible resources
 * precede retained offscreen resources; no parallel cache holds evicted pixels. */
export function selectViewportImages(snapshot: IndexedPageSnapshot,
  visible: readonly DocumentImageMetadata[]): readonly DocumentImageResource[] {
  const previous = snapshot.images ?? [];
  const previousById = new Map(previous.map((image) => [image.id, image]));
  const owners = new Map<string, Set<DocumentNodeRef>>();
  const candidates = new Map<string, DocumentImageMetadata>();
  const references = visible.slice(0, DEFAULT_IMAGE_POLICY.maxResources);
  // Current source ownership is rebuilt through the document's existing index,
  // never a whole-document scan or an accumulating history of CSS owners.
  for (const image of [...previous, ...references]) {
    for (const owner of image.owners) {
      const source = snapshot.document.replaced(owner);
      if (source?.kind !== "image" || source.source !== image.id) continue;
      const current = owners.get(image.id) ?? new Set<DocumentNodeRef>();
      current.add(owner); owners.set(image.id, current);
    }
  }
  for (const candidate of references) {
    const sourceOwners = owners.get(candidate.id);
    const canonicalImage = candidate.id === candidate.requestUrl && sourceOwners !== undefined && candidate.owners.length > 0
      && candidate.owners.every((owner) => sourceOwners.has(owner));
    if (!canonicalImage && !validStyleImage(candidate)) continue;
    const existing = previousById.get(candidate.id);
    if (existing !== undefined && existing.requestUrl !== candidate.requestUrl) continue;
    candidates.set(candidate.id, candidate);
    const current = sourceOwners ?? new Set<DocumentNodeRef>();
    for (const owner of candidate.owners) current.add(owner);
    owners.set(candidate.id, current);
  }
  const limit = Math.min(DEFAULT_IMAGE_POLICY.maxResources, snapshot.imageResourceLimit ?? DEFAULT_IMAGE_POLICY.maxResources);
  const selected = new Map<string, DocumentImageMetadata>();
  const admit = (image: DocumentImageMetadata): void => {
    if (selected.size < limit && !selected.has(image.id)) selected.set(image.id, image);
  };
  for (const image of visible.slice(0, DEFAULT_IMAGE_POLICY.maxResources)) {
    const candidate = candidates.get(image.id);
    if (candidate !== undefined) admit(previousById.get(image.id) ?? candidate);
  }
  for (const image of previous) admit(image);
  for (const image of candidates.values()) admit(image);
  const dimensions = new Map(snapshot.imageIntrinsicDimensions?.map((image) => [image.id, image]));
  const images = [...selected.values()].map((image): DocumentImageResource => {
    const current = [...owners.get(image.id) ?? []];
    const existing = previousById.get(image.id);
    if (existing !== undefined) {
      return current.length === existing.owners.length && current.every((owner, index) => owner === existing.owners[index])
        ? existing : Object.freeze({ ...existing, owners: Object.freeze(current) });
    }
    const known = dimensions.get(image.id);
    return Object.freeze({ id: image.id, requestUrl: image.requestUrl, owners: Object.freeze(current),
      width: known?.width ?? null, height: known?.height ?? null, hasAlpha: null, mimeType: null, status: "pending" });
  });
  return images.length === previous.length && images.every((image, index) => image === previous[index])
    ? previous : Object.freeze(images);
}

/** Keep accepted intrinsic geometry for evicted canonical img URLs only. This
 * metadata cannot grow with dynamic CSS URLs and never retains pixels or owners. */
export function retainImageIntrinsicDimensions(snapshot: IndexedPageSnapshot, images: readonly DocumentImageResource[]):
  NonNullable<IndexedPageSnapshot["imageIntrinsicDimensions"]> {
  const active = new Set(images.map((image) => image.id));
  const previous = snapshot.imageIntrinsicDimensions ?? [];
  const retained = new Map(previous.filter((image) => !active.has(image.id)).map((image) => [image.id, image]));
  const retiring = new Map((snapshot.images ?? []).filter((image) => !active.has(image.id)
    && image.width !== null && image.height !== null).map((image) => [image.id, image]));
  for (const image of retiring.values()) {
    if (image.width === null || image.height === null || !image.owners.some((owner) => {
      const source = snapshot.document.replaced(owner);
      return source?.kind === "image" && source.source === image.id;
    })) continue;
    retained.set(image.id, Object.freeze({ id: image.id, width: image.width, height: image.height }));
  }
  const result = [...retained.values()];
  return result.length === previous.length && result.every((image, index) => image === previous[index])
    ? previous : Object.freeze(result);
}

/** Renderer metadata includes accepted inactive img dimensions without rebuilding
 * the DOM source manifest on every completion or transporting decoded buffers. */
export function pageImageMetadata(snapshot: IndexedPageSnapshot): readonly DocumentImageMetadata[] {
  return Object.freeze([...(snapshot.images ?? []).map(documentImageMetadata),
    ...(snapshot.imageIntrinsicDimensions ?? []).map((image) => Object.freeze({ ...image, requestUrl: image.id,
      owners: Object.freeze([]), hasAlpha: null }))]);
}
