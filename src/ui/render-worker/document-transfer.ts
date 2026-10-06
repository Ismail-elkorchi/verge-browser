import { inspectStylesheetBytes, inspectStylesheetText, type StylesheetResource, type StylesheetSyntaxInstrumentation } from "../../presentation/style/index.js";
import { parseWebDocument } from "../../document/index.js";
import { pageImageMetadata } from "../../app/image-admission.js";
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
  const stylesheetSources: StylesheetResource["source"][] = [];
  const sourceIndexes = new Map<StylesheetResource["syntax"], number>();
  const stylesheets = document.snapshot.stylesheets.map(({ syntax, source, ...occurrence }) => {
    let sourceIndex = sourceIndexes.get(syntax);
    if (sourceIndex === undefined) {
      sourceIndex = stylesheetSources.length;
      sourceIndexes.set(syntax, sourceIndex);
      stylesheetSources.push(source);
    }
    return Object.freeze({ ...occurrence, sourceIndex });
  });
  return Object.freeze({
    documentId: document.id,
    documentRevision: document.documentRevision,
    stateRevision: document.stateRevision,
    sourceText,
    documentMode: document.snapshot.document.documentMode,
    requestUrl: document.snapshot.requestUrl,
    finalUrl: document.snapshot.finalUrl,
    state: transferDocumentState(document.documentState),
    stylesheetSources: Object.freeze(stylesheetSources),
    stylesheets: Object.freeze(stylesheets),
    styleDiagnostics: document.snapshot.styleDiagnostics,
    images: pageImageMetadata(document.snapshot),
  });
}

/** Hydrates one immutable document in the worker; viewport requests never repeat this parse. */
export function hydrateRenderDocument(
  attachment: RenderDocumentAttachment,
  signal?: AbortSignal,
): IndexedPageSnapshot["document"] {
  const document = parseWebDocument(attachment.sourceText, {
    requestUrl: attachment.requestUrl,
    finalUrl: attachment.finalUrl,
  }, signal === undefined ? {} : { signal });
  if (document.documentMode !== attachment.documentMode) throw new Error("Rendering worker document mode changed during hydration.");
  return document;
}

/** Reconstitutes syntax once per source; occurrences keep their own cascade position and conditions. */
export function hydrateRenderStylesheets(
  attachment: RenderDocumentAttachment,
  signal?: AbortSignal,
  instrumentation?: StylesheetSyntaxInstrumentation,
): readonly StylesheetResource[] {
  const sources = attachment.stylesheetSources.map((source) => {
    signal?.throwIfAborted();
    const inspection = source.kind === "text"
      ? inspectStylesheetText(source.text, signal, instrumentation)
      : inspectStylesheetBytes(source.bytes, source.transportEncodingLabel, signal, instrumentation);
    if (inspection.status !== "complete") throw new Error("Admitted stylesheet failed worker hydration.");
    return inspection;
  });
  return Object.freeze(attachment.stylesheets.map(({ sourceIndex, ...occurrence }) => {
    const inspection = sources[sourceIndex];
    if (inspection === undefined || inspection.contentFingerprint !== occurrence.contentFingerprint
      || inspection.parsedRules !== occurrence.parsedRules || inspection.byteSize !== occurrence.byteSize) {
      throw new Error("Rendering worker stylesheet source identity changed during hydration.");
    }
    return Object.freeze({ ...occurrence, syntax: inspection.syntax, source: inspection.source });
  }));
}
