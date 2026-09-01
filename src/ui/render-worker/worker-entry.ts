import { parentPort } from "node:worker_threads";

import {
  AtomicCancellationSignal,
  RenderArtifactStore,
  RenderStageMetrics,
} from "../../presentation/renderer/index.js";
import {
  cssCoordinate,
  cssLengthFromFixed,
  cssNonNegativeLength,
  cssPixels,
  cssPx,
  cssRect,
} from "../../presentation/layout/index.js";
import type { DocumentStateDependencyChange } from "../../presentation/renderer/index.js";
import { documentActionId } from "../../presentation/formatting/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../terminal-measure.js";
import { hydrateRenderDocument } from "./document-transfer.js";
import {
  hydrateDocumentState,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
  type TransferredViewportRenderPayload,
} from "./protocol.js";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);
const workerMetrics = new RenderStageMetrics();
const store = new RenderArtifactStore({ instrumentation: workerMetrics });
const summarizedArtifactKeys = new Map<string, string>();
let viewportRequests = 0;
let completedViewportRequests = 0;
let supersededViewportRequests = 0;

function boundedInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} is outside the rendering-worker allocation boundary.`);
  }
  return value;
}

function artifactKeyIdentity(key: Readonly<Record<string, unknown>>): string {
  return Object.keys(key).sort().map((name) => `${name}=${String(key[name])}`).join("\u0000");
}

function incompleteRenderingLabels(artifacts: ReturnType<RenderArtifactStore["analyze"]>): readonly string[] {
  const labels: string[] = [];
  const add = (
    owner: string,
    outcome: { readonly status: string; readonly budget?: string; readonly limit?: number; readonly reason?: string; readonly feature?: string },
  ): void => {
    if (outcome.status === "truncated" && outcome.budget !== undefined && outcome.limit !== undefined) {
      labels.push(`${owner}.${outcome.budget}=${String(outcome.limit)}`);
    } else if (outcome.status === "rejected") {
      labels.push(`${owner}.${outcome.reason ?? "rejected"}`);
    } else if (outcome.status === "unsupported") {
      labels.push(`${owner}.${outcome.feature ?? "unsupported"}`);
    }
  };
  add("style", artifacts.computedStyles.outcome);
  add("formatting", artifacts.boxTree.outcome);
  add("layout", artifacts.documentLayout.outcome);
  add("display-list", artifacts.documentDisplayList.outcome);
  return Object.freeze(labels);
}

function post(response: RenderWorkerResponse): void {
  parentPort?.postMessage(response);
}

function context(parameters: Extract<RenderWorkerRequest, { readonly kind: "request-viewport" }>["parameters"]) {
  const columns = boundedInteger("columns", parameters.columns, 10_000);
  const rows = boundedInteger("rows", parameters.rows, 10_000);
  boundedInteger("scrollRow", parameters.scrollRow, 1_000_000_000);
  boundedInteger("overscanBefore", parameters.overscanBefore, 1_000);
  boundedInteger("overscanAfter", parameters.overscanAfter, 1_000);
  const width = cssLengthFromFixed(columns * CELL_WIDTH);
  const height = cssLengthFromFixed(rows * ROW_HEIGHT);
  return {
    mediaEnvironment: Object.freeze({
      viewportWidthCssPx: cssPixels(width),
      viewportHeightCssPx: cssPixels(height),
      mediaType: "screen" as const,
      prefersColorScheme: parameters.preferences.colorScheme,
      reducedMotion: parameters.preferences.reducedMotion,
      hover: parameters.preferences.hover,
      pointer: parameters.preferences.pointer,
    }),
    layoutContext: Object.freeze({
      viewport: Object.freeze({
        width: cssNonNegativeLength(width),
        height: cssNonNegativeLength(height),
      }),
      textMeasurer: terminalCssTextMeasurer(
        CELL_WIDTH,
        ROW_HEIGHT,
        parameters.preferences.ambiguousWidth,
      ),
      initialContainingBlock: cssRect(
        cssCoordinate(cssPx(0)),
        cssCoordinate(cssPx(0)),
        width,
        height,
      ),
      scrollport: cssRect(
        cssCoordinate(cssPx(0)),
        cssCoordinate(cssPx(0)),
        width,
        height,
      ),
    }),
    terminalContext: Object.freeze({
      columns,
      rows,
      cellWidthCssPx: CELL_WIDTH,
      rowHeightCssPx: ROW_HEIGHT,
      unicode: parameters.preferences.unicode,
      ambiguousWidth: parameters.preferences.ambiguousWidth,
      colorDepth: parameters.preferences.colorDepth,
      cellMeasurer: terminalCellMeasurer(parameters.preferences.ambiguousWidth),
    }),
  };
}

function receive(message: RenderWorkerRequest): void {
  const cancellationSignals: AtomicCancellationSignal[] = [];
  try {
    if (message.kind === "attach-document") {
      const documentSignal = new AtomicCancellationSignal(
        message.documentCancellation,
        message.documentGeneration,
      );
      cancellationSignals.push(documentSignal);
      store.attach({
        documentId: message.attachment.documentId,
        documentRevision: message.attachment.documentRevision,
        stateRevision: message.attachment.stateRevision,
        document: hydrateRenderDocument(message.attachment, documentSignal),
        state: hydrateDocumentState(message.attachment.state),
        resources: message.attachment.stylesheets,
        styleDiagnostics: message.attachment.styleDiagnostics,
        signal: documentSignal,
      });
      summarizedArtifactKeys.delete(message.attachment.documentId);
      post({ kind: "acknowledged", requestId: message.requestId });
      return;
    }
    if (message.kind === "update-document-state") {
      store.updateState({
        documentId: message.documentId,
        documentRevision: message.documentRevision,
        stateRevision: message.stateRevision,
        state: hydrateDocumentState(message.state),
        changed: new Set(message.changed as DocumentStateDependencyChange[]),
      });
      post({ kind: "acknowledged", requestId: message.requestId });
      return;
    }
    if (message.kind === "release-document") {
      store.release(message.documentId);
      summarizedArtifactKeys.delete(message.documentId);
      post({ kind: "acknowledged", requestId: message.requestId });
      return;
    }
    if (message.kind === "metrics") {
      post({
        kind: "artifact-metrics",
        requestId: message.requestId,
        metrics: Object.freeze({
          ...store.metrics(),
          viewportRequests,
          completedViewportRequests,
          supersededViewportRequests,
          heapUsedBytes: process.memoryUsage().heapUsed,
          stages: workerMetrics.snapshot(),
        }),
      });
      return;
    }
    if (message.kind === "dispose") {
      store.dispose();
      post({ kind: "acknowledged", requestId: message.requestId });
      parentPort?.close();
      return;
    }
    const renderContext = context(message.parameters);
    const documentSignal = new AtomicCancellationSignal(
      message.documentCancellation,
      message.documentGeneration,
    );
    cancellationSignals.push(documentSignal);
    if (message.kind === "search-document") {
      const searchSignal = new AtomicCancellationSignal(
        message.searchCancellation,
        message.searchGeneration,
      );
      cancellationSignals.push(searchSignal);
      const result = store.search({
        documentId: message.documentId,
        documentRevision: message.documentRevision,
        ...renderContext,
        signal: documentSignal,
      }, message.query, message.limit, searchSignal);
      post({
        kind: "search-ready",
        requestId: message.requestId,
        result: Object.freeze({
          ...result,
          matches: Object.freeze(result.matches.map((match) => Object.freeze({
            id: match.id,
            sources: match.sources,
            anchorRow: Math.max(0, Math.floor(
              match.blockOffsetCssPx / renderContext.terminalContext.rowHeightCssPx,
            )),
          }))),
        }),
      });
      return;
    }
    const viewportSignal = new AtomicCancellationSignal(
      message.viewportCancellation,
      message.viewportGeneration,
    );
    cancellationSignals.push(viewportSignal);
    viewportRequests += 1;
    const result = store.renderViewport({
      documentId: message.documentId,
      documentRevision: message.documentRevision,
      viewportRevision: message.viewportRevision,
      ...renderContext,
      window: {
        scrollRow: message.parameters.scrollRow,
        viewportRows: message.parameters.rows,
        overscanBefore: message.parameters.overscanBefore,
        overscanAfter: message.parameters.overscanAfter,
      },
      searchQuery: message.parameters.searchQuery,
      analysisSignal: documentSignal,
      signal: viewportSignal,
    });
    completedViewportRequests += 1;
    const summaryKey = artifactKeyIdentity(
      result.artifactKey as unknown as Readonly<Record<string, unknown>>,
    );
    const includeSummary = summarizedArtifactKeys.get(message.documentId) !== summaryKey;
    if (includeSummary) summarizedArtifactKeys.set(message.documentId, summaryKey);
    const artifacts = store.analyze({
      documentId: message.documentId,
      documentRevision: message.documentRevision,
      ...renderContext,
      signal: documentSignal,
    });
    const payload: TransferredViewportRenderPayload = Object.freeze({
      documentId: result.documentId,
      documentRevision: result.documentRevision,
      stateRevision: result.stateRevision,
      viewportRevision: result.viewportRevision,
      cellBuffer: result.terminal.cellBuffer,
      spatialQuery: result.displayList.spatialQuery,
      hitRegions: result.terminal.hitTestIndex.regions,
      focusTargets: result.terminal.focusMap.targets,
      accessibilityBounds: result.terminal.accessibilityBounds,
      search: result.terminal.search,
      cellRectsByDocumentNode: Object.freeze([...result.terminal.cellRectsByDocumentNode]),
      summary: includeSummary ? Object.freeze({
        documentRowCount: result.documentExtentRows,
        incomplete: incompleteRenderingLabels(artifacts),
        scrollAnchors: Object.freeze(result.scrollAnchors.map((anchor) => Object.freeze({
          documentNode: anchor.documentNode,
          row: Math.max(0, Math.floor(
            anchor.blockOffsetCssPx / renderContext.terminalContext.rowHeightCssPx,
          )),
        }))),
        focusOrder: Object.freeze(result.focusOrder.map((target) => {
          let topRow = Number.MAX_SAFE_INTEGER;
          let bottomRow = Number.MIN_SAFE_INTEGER;
          for (const rect of target.rects) {
            topRow = Math.min(
              topRow,
              Math.floor(rect.y / renderContext.terminalContext.rowHeightCssPx),
            );
            bottomRow = Math.max(
              bottomRow,
              Math.ceil((rect.y + rect.height) / renderContext.terminalContext.rowHeightCssPx),
            );
          }
          if (topRow === Number.MAX_SAFE_INTEGER) {
            const anchor = artifacts.documentGeometry.anchorForNode(target.node);
            topRow = Math.floor((anchor?.blockOffsetCssPx ?? 0) / renderContext.terminalContext.rowHeightCssPx);
            bottomRow = topRow + 1;
          }
          return Object.freeze({
            node: target.node,
            actionId: documentActionId(target.action),
            actionKind: target.action.kind,
            topRow,
            bottomRow,
          });
        })),
        authorStateDependencies: Object.freeze([...artifacts.stylesheetProgram.authorStateDependencies]),
      }) : null,
      stageMetrics: result.stageMetrics,
    });
    post({ kind: "viewport-ready", requestId: message.requestId, payload });
  } catch (error) {
    const cancelled = cancellationSignals.some((signal) => signal.aborted);
    const name = cancelled ? "AbortError" : error instanceof Error ? error.name : "Error";
    if (name === "AbortError" && message.kind === "request-viewport") {
      supersededViewportRequests += 1;
    }
    post({
      kind: "render-failed",
      requestId: message.requestId,
      name,
      message: error instanceof Error ? error.message : String(error),
      aborted: name === "AbortError",
    });
  }
}

if (parentPort === null) throw new Error("The rendering worker must run in a worker thread.");
parentPort.on("message", (message: RenderWorkerRequest) => { receive(message); });
