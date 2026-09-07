import { parseWebDocument } from "../../document/index.js";
import type { IndexedPageSnapshot } from "../../app/types.js";
import type { BrowserDocumentState } from "../model.js";
import { transferDocumentState, type RenderDocumentAttachment } from "./protocol.js";

/** Creates the one-time structured-clone-safe attachment sent to the rendering worker. */
export function renderDocumentAttachment(
  document: BrowserDocumentState,
): RenderDocumentAttachment {
  const sourceText = document.snapshot.document.sourceText;
  if (sourceText === null) {
    throw new Error("The rendering worker requires the retained decoded HTML source.");
  }
  return Object.freeze({
    documentId: document.id,
    documentRevision: document.documentRevision,
    stateRevision: document.stateRevision,
    sourceText,
    requestUrl: document.snapshot.requestUrl,
    finalUrl: document.snapshot.finalUrl,
    state: transferDocumentState(document.documentState),
    stylesheets: document.snapshot.stylesheets,
    styleDiagnostics: document.snapshot.styleDiagnostics,
  });
}

/** Hydrates one immutable document in the worker; viewport requests never repeat this parse. */
export function hydrateRenderDocument(
  attachment: RenderDocumentAttachment,
  signal?: AbortSignal,
): IndexedPageSnapshot["document"] {
  return parseWebDocument(attachment.sourceText, {
    requestUrl: attachment.requestUrl,
    finalUrl: attachment.finalUrl,
  }, signal === undefined ? {} : { signal });
}
