import { selectViewportImages, retainImageIntrinsicDimensions } from "../app/image-admission.js";
import type { DocumentImageMetadata } from "../document/image-resources.js";
import type { TuiEventSource } from "@ismail-elkorchi/terminal-ui/tui";
import { ignoreMessage } from "@ismail-elkorchi/terminal-ui/component";
import type { DocumentImageResource, ImageFailureCode } from "../document/image-resources.js";
import type { IndexedPageSnapshot } from "../app/types.js";
import { currentEntry } from "../app/navigation-history.js";
import type { BrowserController } from "./browser-controller.js";
import type { BrowserDocumentState, BrowserTuiMessage, BrowserTuiState } from "./model.js";
import { browserResourceImageHandles, browserViewportImageHandles, browserViewportImageResources, browserPendingImageAllocations } from "./image-presentation.js";
import type { RasterImage } from "@ismail-elkorchi/terminal-ui";
import type { ViewportCellBuffer } from "../presentation/terminal/index.js";

/** Encoded/decoder workspace has separate acquisition bounds. All UI pixels share this cap. */
export const MAX_RETAINED_IMAGE_BYTES = 64 * 1024 * 1024;

export type ImageResourceMessage = {
  readonly kind: "imageResource";
  readonly documentId: string;
  readonly documentRevision: number;
  readonly resourceRevision: number;
  readonly resource: DocumentImageResource;
} | {
  readonly kind: "imageResourcesFailed";
  /** Scope a retired source failure to the resources it actually admitted. */
  readonly resourceIds?: readonly string[];
  readonly documentId: string;
  readonly documentRevision: number;
  readonly resourceRevision: number;
};

/** Count unique live source buffers and raster handles across tabs/history/candidates.
 * Pending completion owners also reserve their pixel-conversion workspace. */
export function retainedImageBytes(state: BrowserTuiState, addition?: DocumentImageResource,
  transportViewports: Iterable<ViewportCellBuffer> = [], retainedStates: readonly BrowserTuiState[] = []): number {
  const snapshots = new Set<IndexedPageSnapshot>();
  const resources = new Set<DocumentImageResource>();
  const buffers = new Set<ArrayBufferLike>();
  const handles = new Set<RasterImage>();
  let bytes = 0;
  const countHandle = (image: RasterImage): void => {
    if (handles.has(image)) return;
    handles.add(image); bytes += image.byteLength;
  };
  const count = (resource: DocumentImageResource): void => {
    if (resource.status !== "ready" || resources.has(resource)) return;
    resources.add(resource);
    if (!buffers.has(resource.pixels.buffer)) {
      buffers.add(resource.pixels.buffer);
      bytes += resource.pixels.buffer.byteLength;
    }
    for (const image of browserResourceImageHandles(resource)) countHandle(image);
  };
  const countViewport = (viewport: ViewportCellBuffer): void => {
    for (const resource of browserViewportImageResources(viewport)) count(resource);
    for (const image of browserViewportImageHandles(viewport)) countHandle(image);
  };
  for (const owner of new Set([state, ...retainedStates])) for (const tab of [...owner.documents, ...owner.recentlyClosed]) {
    if (tab.kind !== "ready") continue;
    snapshots.add(tab.snapshot);
    for (const entry of tab.navigation.entries) snapshots.add(entry.snapshot);
    const viewports: readonly (typeof tab.rendering.viewport | undefined)[] = [tab.rendering.viewport, tab.rendering.previousViewport];
    for (const viewport of viewports) {
      if (viewport === null || viewport === undefined) continue;
      countViewport(viewport.cellBuffer);
    }
  }
  for (const snapshot of snapshots) for (const resource of snapshot.images ?? []) count(resource);
  for (const viewport of transportViewports) countViewport(viewport);
  if (addition !== undefined) count(addition);
  const pending = browserPendingImageAllocations();
  for (const resource of pending.resources) count(resource);
  for (const image of pending.images) countHandle(image);
  return bytes + pending.reservedBytes;
}

function failed(resource: DocumentImageResource, failure: ImageFailureCode, reason: string): DocumentImageResource {
  return Object.freeze({ id: resource.id, requestUrl: resource.requestUrl, owners: resource.owners,
    width: resource.width, height: resource.height, hasAlpha: resource.hasAlpha, mimeType: resource.mimeType,
    status: "failed", failure, reason });
}

/** Image completion changes derived resources, never the current document or interaction state. */
export function acceptImageResource(state: BrowserTuiState, message: ImageResourceMessage,
  transportViewports: Iterable<ViewportCellBuffer> = [], retainedStates: readonly BrowserTuiState[] = []): BrowserTuiState {
  const document = state.documents[state.activeDocumentIndex];
  if (document?.kind !== "ready" || document.id !== message.documentId || document.loading
    || document.documentRevision !== message.documentRevision
    || (document.snapshot.imageResourceRevision ?? 0) !== message.resourceRevision) return state;
  const resources = document.snapshot.images ?? [];
  const images = resources.map((previous) => {
    if (previous.status !== "pending") return previous;
    if (message.kind === "imageResourcesFailed") {
      if (message.resourceIds !== undefined && !message.resourceIds.includes(previous.id)) return previous;
      return failed(previous, "acquisition-failed", "Image acquisition did not complete.");
    }
    const candidate = message.resource;
    if (previous.id !== candidate.id || previous.requestUrl !== candidate.requestUrl) return previous;
    let resource = previous.owners.length === candidate.owners.length && previous.owners.every((owner, index) => owner === candidate.owners[index])
      ? candidate : Object.freeze({ ...candidate, owners: previous.owners });
    if (candidate.status === "ready" && retainedImageBytes(state, candidate, transportViewports, retainedStates) > MAX_RETAINED_IMAGE_BYTES) {
      resource = failed(resource, "resource-limit", "The browser image retention limit was reached.");
    }
    if (resource === previous || (resource.status === "pending" && previous.width === resource.width
      && previous.height === resource.height && previous.hasAlpha === resource.hasAlpha && previous.mimeType === resource.mimeType)) return previous;
    return resource;
  });
  if (images.every((resource, index) => resource === resources[index])) return state;
  const paintChanged = images.some((resource, index) => resources[index]?.hasAlpha !== resource.hasAlpha
    || (resource.status === "ready" && resources[index].status !== "ready"));
  const geometryChanged = images.some((resource, index) => {
    const previous = resources[index];
    return previous?.width !== resource.width || previous.height !== resource.height;
  });
  const retained = Object.freeze(images);
  const sourceId = currentEntry(document.navigation)?.documentId;
  const navigation = sourceId === undefined ? document.navigation : Object.freeze({ ...document.navigation,
    entries: Object.freeze(document.navigation.entries.map((entry) => entry.documentId !== sourceId ? entry
      : Object.freeze({ ...entry, snapshot: Object.freeze({ ...entry.snapshot, images: retained }) }))) });
  const updated: BrowserDocumentState = {
    ...document,
    snapshot: Object.freeze({ ...document.snapshot, images: retained }),
    navigation,
    ...(geometryChanged || paintChanged ? {
      stateRevision: document.stateRevision + 1,
      search: document.search === null ? null : { ...document.search, anchors: new Map(), layoutRevision: null },
      rendering: { ...document.rendering, requestKey: null, pendingSearch: null,
        searchRequestGeneration: document.rendering.searchRequestGeneration + 1 },
    } : {}),
  };
  return { ...state, documents: state.documents.map((entry) => entry === document ? updated : entry) };
}

/** One active document source; background tabs pause without losing accepted images. */
export function imageSources(controller: BrowserController, state: BrowserTuiState): readonly TuiEventSource<BrowserTuiMessage>[] {
  const document = state.documents[state.activeDocumentIndex];
  if (document?.kind !== "ready" || document.loading || document.rendering.committedViewportRevision === 0
    || !(document.snapshot.images ?? []).some((resource) => resource.status === "pending")) return [];
  const failure: ImageResourceMessage = { kind: "imageResourcesFailed", documentId: document.id,
    documentRevision: document.documentRevision, resourceRevision: document.snapshot.imageResourceRevision ?? 0,
    resourceIds: Object.freeze((document.snapshot.images ?? []).filter((resource) => resource.status === "pending").map((resource) => resource.id)) };
  return [{
    id: `images:${document.id}`,
    generation: `${String(document.documentRevision)}:${String(document.snapshot.imageResourceRevision ?? 0)}`,
    channel: { capacity: 1 },
    async run(context, sink) {
      try {
        await controller.acquireImages(document, context.signal, async (resource) => {
          context.signal.throwIfAborted();
          await sink.emit({ kind: "reliable", message: { kind: "imageResource", documentId: document.id,
            documentRevision: document.documentRevision, resourceRevision: document.snapshot.imageResourceRevision ?? 0, resource } });
        });
      } catch {
        context.signal.throwIfAborted();
        await sink.emit({ kind: "reliable", message: failure });
      }
    },
    onLifecycle: (event) => event.kind === "failed" ? failure : ignoreMessage(),
  }];
}

/** Called only after document, state and viewport revision admission succeeds. */
export function acceptViewportImageAdmission(document: BrowserDocumentState,
  visible: readonly DocumentImageMetadata[]): BrowserDocumentState {
  const images = selectViewportImages(document.snapshot, visible);
  if (images === document.snapshot.images || (document.snapshot.images === undefined && images.length === 0)) return document;
  const previous = document.snapshot.images ?? [];
  const manifestChanged = previous.length !== images.length || images.some((image, index) => image.id !== previous[index]?.id
    || image.requestUrl !== previous[index].requestUrl);
  const imageResourceRevision = (document.snapshot.imageResourceRevision ?? 0) + (manifestChanged ? 1 : 0);
  const imageIntrinsicDimensions = retainImageIntrinsicDimensions(document.snapshot, images);
  const snapshot = Object.freeze({ ...document.snapshot, images, imageResourceRevision, imageIntrinsicDimensions });
  const sourceId = currentEntry(document.navigation)?.documentId;
  const navigation = sourceId === undefined ? document.navigation : Object.freeze({ ...document.navigation,
    entries: Object.freeze(document.navigation.entries.map((entry) => entry.documentId !== sourceId ? entry
      : Object.freeze({ ...entry, snapshot: Object.freeze({ ...entry.snapshot, images, imageResourceRevision, imageIntrinsicDimensions }) }))) });
  return { ...document, snapshot, navigation,
    stateRevision: document.stateRevision + 1,
    rendering: { ...document.rendering, requestKey: null } };
}
