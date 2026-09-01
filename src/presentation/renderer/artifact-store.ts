import { buildFormattingTree } from "../formatting/index.js";
import {
  buildLayoutFragmentTree,
  cssCoordinate,
  cssPx,
  cssRect,
} from "../layout/index.js";
import {
  buildTextSearchIndex,
  projectTextSearchToLayout,
  type TextSearchLayoutProjection,
} from "../search/index.js";
import { compileStylesheetProgram, resolveStyles, type SelectorStateDependency } from "../style/index.js";
import { buildInlineItemStreamSet } from "../text/index.js";
import {
  buildDisplayListSpatialIndex,
  buildDocumentGeometryIndex,
  buildDocumentDisplayList,
  buildViewportDisplayList,
  buildViewportTerminalResult,
  rasterizeViewportDisplayList,
} from "../terminal/index.js";
import { measured, RenderStageMetrics } from "./instrumentation.js";
import type {
  ArtifactDependencyKey,
  AttachDocumentArtifactsInput,
  DocumentAnalysisRequest,
  DocumentRenderArtifacts,
  DocumentSearchGeometryResult,
  DocumentStateDependencyChange,
  RenderArtifactStoreMetrics,
  RenderArtifactStoreOptions,
  RetainedViewportRenderResult,
  UpdateDocumentArtifactsStateInput,
  ViewportRenderRequest,
} from "./types.js";

const DEFAULT_MAX_RETAINED_ARTIFACT_BYTES = 512 * 1024 * 1024;

interface AttachedDocument {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly program: ReturnType<typeof compileStylesheetProgram>;
  readonly budgets: AttachDocumentArtifactsInput["budgets"];
  state: AttachDocumentArtifactsInput["state"];
  stateRevision: number;
  analysisStateRevision: number;
  readonly analyses: Map<string, RetainedAnalysis>;
  readonly searches: Map<string, RetainedSearchProjection>;
}

interface RetainedAnalysis {
  readonly artifacts: DocumentRenderArtifacts;
  lastUsed: number;
}

interface RetainedSearchProjection {
  readonly projection: TextSearchLayoutProjection;
  lastUsed: number;
}

const MAX_RETAINED_SEARCH_PROJECTIONS_PER_DOCUMENT = 32;

function mediaKey(document: AttachedDocument, request: DocumentAnalysisRequest): string {
  const environment = request.mediaEnvironment;
  const dependencies = document.program.dependencies;
  return [environment.mediaType,
    dependencies.mediaInlineSize ? environment.viewportWidthCssPx : "-",
    dependencies.mediaBlockSize ? environment.viewportHeightCssPx : "-",
    dependencies.mediaColorScheme ? environment.prefersColorScheme : "-",
    dependencies.mediaReducedMotion ? (environment.reducedMotion ? 1 : 0) : "-",
    dependencies.mediaHover ? environment.hover : "-",
    dependencies.mediaPointer ? environment.pointer : "-",
  ].join(":");
}

function layoutKey(document: AttachedDocument, request: DocumentAnalysisRequest): string {
  const context = request.layoutContext;
  return `${String(context.viewport.width)}x${document.program.dependencies.viewportBlockSize
    ? String(context.viewport.height) : "independent"}`;
}

function textMetricsKey(request: DocumentAnalysisRequest): string {
  const metrics = request.layoutContext.textMeasurer.defaultFontMetrics();
  return [
    metrics.fontSize,
    metrics.ascent,
    metrics.descent,
    metrics.lineGap,
    metrics.chAdvance,
    request.terminalContext.cellWidthCssPx,
    request.terminalContext.rowHeightCssPx,
    request.terminalContext.ambiguousWidth,
  ].join(":");
}

function dependencyKey(document: AttachedDocument, request: DocumentAnalysisRequest): ArtifactDependencyKey {
  const media = mediaKey(document, request);
  const layoutViewport = layoutKey(document, request);
  const textMetrics = textMetricsKey(request);
  const computedStyleMap = [document.program.fingerprint, document.analysisStateRevision, media].join(":");
  const boxTree = [computedStyleMap, document.analysisStateRevision].join(":");
  const inlineItemStreams = boxTree;
  const logicalTextIndex = inlineItemStreams;
  const documentLayout = [inlineItemStreams, layoutViewport, textMetrics].join(":");
  const documentDisplayList = documentLayout;
  return Object.freeze({
    documentRevision: document.documentRevision,
    stylesheetProgram: document.program.fingerprint,
    stateRevision: document.analysisStateRevision,
    media,
    layoutViewport,
    textMetrics,
    computedStyleMap,
    boxTree,
    inlineItemStreams,
    logicalTextIndex,
    documentLayout,
    documentDisplayList,
    documentGeometry: documentDisplayList,
  });
}

function keyIdentity(key: ArtifactDependencyKey): string {
  return [
    key.documentRevision,
    key.stylesheetProgram,
    key.stateRevision,
    key.media,
    key.layoutViewport,
    key.textMetrics,
    key.computedStyleMap,
    key.boxTree,
    key.inlineItemStreams,
    key.logicalTextIndex,
    key.documentLayout,
    key.documentDisplayList,
    key.documentGeometry,
  ].join("\u0000");
}

function estimatedArtifactCost(artifacts: Omit<DocumentRenderArtifacts, "retainedCost">): number {
  const styles = artifacts.computedStyles.outcome.status === "complete"
    ? artifacts.computedStyles.outcome.computedNodes : 0;
  const boxes = artifacts.boxTree.outcome.status === "complete" ? artifacts.boxTree.outcome.nodes : 0;
  const fragments = artifacts.documentLayout.outcome.status === "complete"
    ? artifacts.documentLayout.outcome.fragments : 0;
  return artifacts.stylesheetProgram.retainedByteSize
    + styles * 512
    + boxes * 320
    + fragments * 640
    + artifacts.documentDisplayList.commands.length * 384
    + artifacts.documentGeometry.retainedRectangles * 64;
}

function changedSelectorDependency(change: DocumentStateDependencyChange): SelectorStateDependency | null {
  if (change === "focus" || change === "hover" || change === "active" || change === "target") return change;
  if (change === "checked-selected") return "checked-selected";
  if (change === "disclosure-open") return "disclosure-open";
  return null;
}

/** Worker-owned store with no scroll-keyed complete render results. */
export class RenderArtifactStore {
  readonly #documents = new Map<string, AttachedDocument>();
  readonly #maximumCost: number;
  readonly #instrumentation: RenderArtifactStoreOptions["instrumentation"];
  #clock = 0;
  #evictions = 0;

  public constructor(options: RenderArtifactStoreOptions = {}) {
    this.#maximumCost = options.maxRetainedArtifactBytes ?? DEFAULT_MAX_RETAINED_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.#maximumCost) || this.#maximumCost < 1) {
      throw new TypeError("maxRetainedArtifactBytes must be a positive safe integer.");
    }
    this.#instrumentation = options.instrumentation;
  }

  public attach(input: AttachDocumentArtifactsInput): void {
    input.signal?.throwIfAborted();
    this.release(input.documentId);
    const program = measured(this.#instrumentation, "stylesheet-program-compilation", () =>
      compileStylesheetProgram({
        document: input.document,
        resources: input.resources,
        ...(input.styleDiagnostics === undefined ? {} : { initialDiagnostics: input.styleDiagnostics }),
        ...(input.budgets?.style === undefined ? {} : { budgets: input.budgets.style }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    );
    this.#documents.set(input.documentId, {
      documentId: input.documentId,
      documentRevision: input.documentRevision,
      program,
      budgets: input.budgets,
      state: input.state,
      stateRevision: input.stateRevision,
      analysisStateRevision: input.stateRevision,
      analyses: new Map(),
      searches: new Map(),
    });
  }

  public updateState(input: UpdateDocumentArtifactsStateInput): void {
    const document = this.#document(input.documentId, input.documentRevision);
    document.state = input.state;
    document.stateRevision = input.stateRevision;
    const invalidates = input.changed.has("control-content") || [...input.changed].some((change) => {
      const selectorDependency = changedSelectorDependency(change);
      if (selectorDependency === null || !document.program.stateDependencies.has(selectorDependency)) return false;
      return true;
    });
    if (invalidates) {
      document.analysisStateRevision = input.stateRevision;
      document.analyses.clear();
      document.searches.clear();
    }
  }

  public analyze(request: DocumentAnalysisRequest): DocumentRenderArtifacts {
    return this.#analyze(request, this.#instrumentation);
  }

  #reusable(
    document: AttachedDocument,
    dependency: keyof Pick<ArtifactDependencyKey,
      "computedStyleMap" | "boxTree" | "inlineItemStreams" | "logicalTextIndex"
      | "documentLayout" | "documentDisplayList" | "documentGeometry">,
    identity: string,
  ): DocumentRenderArtifacts | null {
    let retained: RetainedAnalysis | null = null;
    for (const candidate of document.analyses.values()) {
      if (candidate.artifacts.key[dependency] !== identity) continue;
      if (retained === null || candidate.lastUsed > retained.lastUsed) retained = candidate;
    }
    if (retained !== null) retained.lastUsed = ++this.#clock;
    return retained?.artifacts ?? null;
  }

  #analyze(
    request: DocumentAnalysisRequest,
    instrumentation: RenderArtifactStoreOptions["instrumentation"],
  ): DocumentRenderArtifacts {
    const document = this.#document(request.documentId, request.documentRevision);
    const key = dependencyKey(document, request);
    const identity = keyIdentity(key);
    const retained = document.analyses.get(identity);
    if (retained !== undefined) {
      retained.lastUsed = ++this.#clock;
      return retained.artifacts;
    }
    request.signal?.throwIfAborted();
    const retainedStyles = this.#reusable(document, "computedStyleMap", key.computedStyleMap);
    const computedStyles = retainedStyles?.computedStyles ?? measured(instrumentation, "computed-style-resolution", () => resolveStyles({
      program: document.program,
      state: document.state,
      environment: request.mediaEnvironment,
      ...(instrumentation === undefined ? {} : {
        instrumentation: {
          record: (stage: "selector-matching" | "custom-property-substitution", elapsed: number) => {
            instrumentation.record(stage, elapsed);
          },
        },
      }),
      ...(document.budgets?.style === undefined ? {} : { budgets: document.budgets.style }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
    const retainedBoxTree = this.#reusable(document, "boxTree", key.boxTree);
    const boxTree = retainedBoxTree?.boxTree ?? measured(instrumentation, "box-tree-construction", () => buildFormattingTree({
      document: document.program.document,
      state: document.state,
      styles: computedStyles,
      ...(document.budgets?.formatting === undefined ? {} : { budgets: document.budgets.formatting }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
    const retainedInlineItems = this.#reusable(document, "inlineItemStreams", key.inlineItemStreams);
    const inlineItemStreams = retainedInlineItems?.inlineItemStreams ?? measured(instrumentation, "inline-item-stream-construction", () =>
      buildInlineItemStreamSet(boxTree, request.signal)
    );
    const retainedSearchIndex = this.#reusable(document, "logicalTextIndex", key.logicalTextIndex);
    const textSearchIndex = retainedSearchIndex?.textSearchIndex ?? measured(instrumentation, "logical-search-index-construction", () =>
      buildTextSearchIndex(boxTree, inlineItemStreams, request.signal)
    );
    const initial = request.layoutContext.initialContainingBlock;
    const scrollIndependentContext = {
      ...request.layoutContext,
      scrollport: cssRect(
        cssCoordinate(cssPx(0)),
        cssCoordinate(cssPx(0)),
        initial.width,
        initial.height,
      ),
      ...(document.budgets?.layout === undefined ? {} : { budgets: document.budgets.layout }),
    };
    const retainedLayout = this.#reusable(document, "documentLayout", key.documentLayout);
    const documentLayout = retainedLayout?.documentLayout ?? measured(instrumentation, "normal-flow-layout", () => buildLayoutFragmentTree({
      formatting: boxTree,
      inlineItemStreams,
      context: scrollIndependentContext,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
    const retainedDisplayList = this.#reusable(document, "documentDisplayList", key.documentDisplayList);
    const documentDisplayList = retainedDisplayList?.documentDisplayList ?? measured(instrumentation, "document-display-list-construction", () =>
      buildDocumentDisplayList({
        layout: documentLayout,
        context: {
          ...request.terminalContext,
          colorDepth: 24,
          ...(document.budgets?.terminal === undefined ? {} : { budgets: document.budgets.terminal }),
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    );
    const retainedGeometry = this.#reusable(document, "documentGeometry", key.documentGeometry);
    const displayListSpatialIndex = retainedDisplayList?.displayListSpatialIndex ?? measured(
      instrumentation,
      "display-list-spatial-index-construction",
      () => buildDisplayListSpatialIndex(documentDisplayList),
    );
    const documentGeometry = retainedGeometry?.documentGeometry
      ?? measured(instrumentation, "document-geometry-index-construction", () =>
        buildDocumentGeometryIndex(documentDisplayList, request.signal)
      );
    const incomplete = {
      key,
      stylesheetProgram: document.program,
      computedStyles,
      boxTree,
      inlineItemStreams,
      textSearchIndex,
      documentLayout,
      documentDisplayList,
      displayListSpatialIndex,
      documentGeometry,
    };
    const artifacts: DocumentRenderArtifacts = Object.freeze({
      ...incomplete,
      retainedCost: estimatedArtifactCost(incomplete),
    });
    document.analyses.set(identity, { artifacts, lastUsed: ++this.#clock });
    this.#evict(identity, document.documentId);
    return artifacts;
  }

  public renderViewport(request: ViewportRenderRequest): RetainedViewportRenderResult {
    const localMetrics = new RenderStageMetrics();
    const instrumentation = {
      record: (identity, elapsed) => {
        localMetrics.record(identity, elapsed);
        this.#instrumentation?.record(identity, elapsed);
      },
      increment: (identity, count) => {
        localMetrics.increment(identity, count);
        this.#instrumentation?.increment(identity, count);
      },
    } satisfies NonNullable<RenderArtifactStoreOptions["instrumentation"]>;
    const artifacts = this.#analyze({
      ...request,
      ...(request.analysisSignal === undefined ? {} : { signal: request.analysisSignal }),
    }, instrumentation);
    const terminalBudgets = this.#document(
      request.documentId,
      request.documentRevision,
    ).budgets?.terminal;
    const record = <T>(stage: Parameters<typeof measured>[1], operation: () => T): T => measured(
      instrumentation,
      stage,
      operation,
    );
    const displayList = record("viewport-display-list-construction", () => buildViewportDisplayList({
      documentDisplayList: artifacts.documentDisplayList,
      spatialIndex: artifacts.displayListSpatialIndex,
      context: {
        ...request.terminalContext,
        ...(terminalBudgets === undefined ? {} : { budgets: terminalBudgets }),
      },
      window: request.window,
      instrumentation,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
    const cells = record("cell-rasterization", () => rasterizeViewportDisplayList({
      displayList,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
    const terminal = record("terminal-index-construction", () => buildViewportTerminalResult({
      displayList,
      cellBuffer: cells.cellBuffer,
      documentGeometry: artifacts.documentGeometry,
      ...(request.searchQuery === undefined || request.searchQuery === null
        ? {}
        : {
          searchProjection: this.#searchProjection(
            this.#document(request.documentId, request.documentRevision),
            artifacts,
            request.searchQuery,
            10_000,
            request.signal,
          ),
        }),
      truncations: cells.truncations,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
    const document = this.#document(request.documentId, request.documentRevision);
    return Object.freeze({
      documentId: request.documentId,
      documentRevision: request.documentRevision,
      stateRevision: document.stateRevision,
      viewportRevision: request.viewportRevision,
      artifactKey: artifacts.key,
      displayList,
      terminal,
      documentExtentRows: Math.max(
        1,
        Math.ceil(
          (artifacts.documentGeometry.documentExtent.y + artifacts.documentGeometry.documentExtent.height)
          / request.terminalContext.rowHeightCssPx,
        ),
      ),
      scrollAnchors: artifacts.documentGeometry.scrollAnchors,
      focusOrder: artifacts.documentGeometry.focusOrder,
      stageMetrics: localMetrics.snapshot(),
    });
  }

  /** Queries the retained logical text index and maps stable matches to document-space anchors. */
  public search(
    request: DocumentAnalysisRequest,
    query: string,
    limit = 2_000,
    operationSignal: AbortSignal | undefined = request.signal,
  ): DocumentSearchGeometryResult {
    const bounded = query.slice(0, 1_024);
    const artifacts = this.analyze(request);
    const projection = this.#searchProjection(
      this.#document(request.documentId, request.documentRevision),
      artifacts,
      bounded,
      limit,
      operationSignal,
    );
    const logical = { matches: projection.matches, truncated: projection.truncated };
    const spans = projection.spans;
    const byMatch = new Map<string, typeof spans[number][]>();
    for (const span of spans) {
      const values = byMatch.get(span.match) ?? [];
      values.push(span);
      byMatch.set(span.match, values);
    }
    return Object.freeze({
      query: bounded,
      matches: Object.freeze(logical.matches.map((match) => {
        const visual = byMatch.get(match.id) ?? [];
        let blockOffsetCssPx = 0;
        let first = true;
        for (const span of visual) {
          const y = artifacts.documentLayout.fragment(span.fragment).borderRect.y;
          if (first || y < blockOffsetCssPx) blockOffsetCssPx = y;
          first = false;
        }
        return Object.freeze({
          id: match.id,
          sources: Object.freeze([...new Set(match.slices.map((slice) => slice.source))]),
          blockOffsetCssPx,
        });
      })),
      truncated: logical.truncated,
    });
  }

  public release(documentId: string): void {
    const document = this.#documents.get(documentId);
    if (document === undefined) return;
    document.program.propertyValidation.clear();
    document.program.substitutedValues.clear();
    document.program.selectorRuntime.clear();
    document.analyses.clear();
    document.searches.clear();
    this.#documents.delete(documentId);
  }

  public dispose(): void {
    for (const id of [...this.#documents.keys()]) this.release(id);
  }

  public metrics(): RenderArtifactStoreMetrics {
    let retainedAnalyses = 0;
    let retainedCost = 0;
    for (const document of this.#documents.values()) {
      retainedAnalyses += document.analyses.size;
      for (const analysis of document.analyses.values()) retainedCost += analysis.artifacts.retainedCost;
    }
    return Object.freeze({
      attachedDocuments: this.#documents.size,
      retainedAnalyses,
      retainedCost,
      evictions: this.#evictions,
    });
  }

  #document(id: string, revision: number): AttachedDocument {
    const document = this.#documents.get(id);
    if (document === undefined || document.documentRevision !== revision) {
      throw new RangeError(`Unknown render document revision: ${id}@${String(revision)}`);
    }
    return document;
  }

  #searchProjection(
    document: AttachedDocument,
    artifacts: DocumentRenderArtifacts,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): TextSearchLayoutProjection {
    const bounded = query.slice(0, 1_024);
    const identity = `${keyIdentity(artifacts.key)}\u0000${String(limit)}\u0000${bounded}`;
    const retained = document.searches.get(identity);
    if (retained !== undefined) {
      retained.lastUsed = ++this.#clock;
      return retained.projection;
    }
    const projection = projectTextSearchToLayout(
      artifacts.textSearchIndex,
      artifacts.documentLayout,
      bounded,
      limit,
      signal,
    );
    document.searches.set(identity, { projection, lastUsed: ++this.#clock });
    while (document.searches.size > MAX_RETAINED_SEARCH_PROJECTIONS_PER_DOCUMENT) {
      let oldest: { readonly identity: string; readonly lastUsed: number } | null = null;
      for (const [searchIdentity, search] of document.searches) {
        if (oldest === null || search.lastUsed < oldest.lastUsed) {
          oldest = { identity: searchIdentity, lastUsed: search.lastUsed };
        }
      }
      if (oldest === null) break;
      document.searches.delete(oldest.identity);
    }
    return projection;
  }

  #evict(protectedIdentity: string, protectedDocument: string): void {
    while (this.metrics().retainedCost > this.#maximumCost) {
      let oldest: { document: AttachedDocument; identity: string; lastUsed: number } | null = null;
      for (const document of this.#documents.values()) {
        for (const [identity, analysis] of document.analyses) {
          if (document.documentId === protectedDocument && identity === protectedIdentity) continue;
          if (oldest === null || analysis.lastUsed < oldest.lastUsed) {
            oldest = { document, identity, lastUsed: analysis.lastUsed };
          }
        }
      }
      if (oldest === null) break;
      oldest.document.analyses.delete(oldest.identity);
      for (const identity of oldest.document.searches.keys()) {
        if (identity.startsWith(`${oldest.identity}\u0000`)) oldest.document.searches.delete(identity);
      }
      this.#evictions += 1;
    }
  }
}
