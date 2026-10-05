import type { TuiEventSource } from "@ismail-elkorchi/terminal-ui/tui";
import { ignoreMessage } from "@ismail-elkorchi/terminal-ui/component";
import type { DocumentImageResource, ImageFailureCode } from "../document/image-resources.js";
import type { IndexedPageSnapshot } from "../app/types.js";
import { currentEntry } from "../app/navigation-history.js";
import type { BrowserController } from "./browser-controller.js";
import type { BrowserDocumentState, BrowserTuiMessage, BrowserTuiState } from "./model.js";
import { prepareBrowserImage } from "./image-presentation.js";

/** Encoded/decoder workspace has separate acquisition bounds. Reserve the UI raster copy here. */
export const MAX_RETAINED_IMAGE_BYTES = 64 * 1024 * 1024;

export type ImageResourceMessage = {
  readonly kind: "imageResource";
  readonly documentId: string;
  readonly documentRevision: number;
  readonly resource: DocumentImageResource;
} | {
  readonly kind: "imageResourcesFailed";
  readonly documentId: string;
  readonly documentRevision: number;
};

/** Count owned buffers once across active tabs, closed tabs and their history entries. */
export function retainedImageBytes(state: BrowserTuiState, addition?: DocumentImageResource): number {
  const snapshots = new Set<IndexedPageSnapshot>();
  const resources = new Set<DocumentImageResource>();
  const buffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  const count = (resource: DocumentImageResource): void => {
    if (resource.status !== "ready" || resources.has(resource)) return;
    resources.add(resource);
    bytes += resource.pixels.byteLength;
    if (!buffers.has(resource.pixels.buffer)) {
      buffers.add(resource.pixels.buffer);
      bytes += resource.pixels.buffer.byteLength;
    }
  };
  for (const tab of [...state.documents, ...state.recentlyClosed]) {
    if (tab.kind !== "ready") continue;
    snapshots.add(tab.snapshot);
    for (const entry of tab.navigation.entries) snapshots.add(entry.snapshot);
  }
  for (const snapshot of snapshots) for (const resource of snapshot.images ?? []) count(resource);
  if (addition !== undefined) count(addition);
  return bytes;
}

function failed(resource: DocumentImageResource, failure: ImageFailureCode, reason: string): DocumentImageResource {
  return Object.freeze({ id: resource.id, requestUrl: resource.requestUrl, owners: resource.owners,
    width: resource.width, height: resource.height, mimeType: resource.mimeType,
    status: "failed", failure, reason });
}

/** Image completion changes derived resources, never the current document or interaction state. */
export function acceptImageResource(state: BrowserTuiState, message: ImageResourceMessage): BrowserTuiState {
  const document = state.documents[state.activeDocumentIndex];
  if (document?.kind !== "ready" || document.id !== message.documentId || document.loading
    || document.documentRevision !== message.documentRevision) return state;
  const resources = document.snapshot.images ?? [];
  const images = resources.map((previous) => {
    if (previous.status !== "pending") return previous;
    if (message.kind === "imageResourcesFailed") {
      return failed(previous, "acquisition-failed", "Image acquisition did not complete.");
    }
    const candidate = message.resource;
    if (previous.id !== candidate.id || previous.requestUrl !== candidate.requestUrl) return previous;
    let resource = candidate;
    if (candidate.status === "ready" && retainedImageBytes(state, candidate) > MAX_RETAINED_IMAGE_BYTES) {
      resource = failed(candidate, "resource-limit", "The browser image retention limit was reached.");
    }
    if (resource === previous || (resource.status === "pending" && previous.width === resource.width
      && previous.height === resource.height && previous.mimeType === resource.mimeType)) return previous;
    return resource;
  });
  if (images.every((resource, index) => resource === resources[index])) return state;
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
    ...(geometryChanged ? {
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
  if (document?.kind !== "ready" || document.loading
    || !(document.snapshot.images ?? []).some((resource) => resource.status === "pending")) return [];
  const failure: ImageResourceMessage = { kind: "imageResourcesFailed", documentId: document.id,
    documentRevision: document.documentRevision };
  return [{
    id: `images:${document.id}`,
    generation: document.documentRevision,
    channel: { capacity: 1 },
    async run(context, sink) {
      try {
        await controller.acquireImages(document, context.signal, async (resource) => {
          context.signal.throwIfAborted();
          prepareBrowserImage(resource);
          context.signal.throwIfAborted();
          await sink.emit({ kind: "reliable", message: { kind: "imageResource", documentId: document.id,
            documentRevision: document.documentRevision, resource } });
        });
      } catch {
        context.signal.throwIfAborted();
        await sink.emit({ kind: "reliable", message: failure });
      }
    },
    onLifecycle: (event) => event.kind === "failed" ? failure : ignoreMessage(),
  }];
}
