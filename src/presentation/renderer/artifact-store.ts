import type { DocumentImageMetadata } from "../../document/index.js";
import { withPackedAllocationCheck, finishPackedConstructionPhase } from "../../memory/packed.js";
import { retainedSideCacheRevision, retainedSideCaches, estimatedRetainedCost, RetainedCostAccounting, RenderBudgetExceededError, type RetainedCostOwner } from "../../memory/retained-cost.js";
import { buildFormattingTree } from "../formatting/index.js";
import {
  buildLayoutFragmentTree,
  textMeasurementDependencyKey,
  cssCoordinate,
  cssPx,
  cssRect,
} from "../layout/index.js";
import {
  buildTextSearchIndex,
  projectTextSearchToLayout,
  type TextSearchLayoutProjection,
} from "../search/index.js";
import { compareStyleSnapshots, compileStylesheetProgram, stylesheetOwnershipRoots, resolveStyles, type SelectorStateDependency } from "../style/index.js";
import { isValidMediaEnvironment, mediaApplies } from "../style/media.js";
import { clearTextSearchQueryCache, textSearchQueryCache } from "../search/text-search-index.js";
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

type PhaseName = "computedStyles" | "boxTree" | "inlineItemStreams" | "textSearchIndex"
  | "documentLayout" | "documentDisplayList" | "displayListSpatialIndex" | "documentGeometry";
type PhaseResources = { [P in PhaseName]: Map<string, PhaseResource<DocumentRenderArtifacts[P]>> };
interface PhaseResource<T extends object> {
  readonly value: T;
  readonly owner: RetainedCostOwner;
  lastUsed: number;
  pins: number;
}
interface StyleEvaluation {
  readonly identity: string;
  readonly formattingIdentity: string;
  readonly reporting: string;
  readonly snapshot: DocumentRenderArtifacts["computedStyles"];
  readonly media: string;
  readonly stateRevision: number;
  lastUsed: number;
}
interface AttachedDocument {
  readonly documentId: string;
  documentRevision: number;
  readonly program: ReturnType<typeof compileStylesheetProgram>;
  readonly budgets: AttachDocumentArtifactsInput["budgets"];
  readonly attachmentOwner: RetainedCostOwner;
  stateOwner: RetainedCostOwner;
  imagesOwner: RetainedCostOwner;
  images: readonly DocumentImageMetadata[];
  imageDimensionsRevision: number;
  imageMetadataRevision: number;
  cacheOwners: readonly RetainedCostOwner[];
  readonly sideCacheSources: Map<object, number>;
  readonly mutableOwners: Map<object, { readonly owner: RetainedCostOwner; readonly revision: number }>;
  readonly queryOwners: Map<DocumentRenderArtifacts["textSearchIndex"], { readonly owner: RetainedCostOwner; readonly revision: number }>;
  state: AttachDocumentArtifactsInput["state"];
  stateRevision: number;
  analysisStateRevision: number;
  textStateRevision: number;
  logicalText: { readonly key: string; readonly stateRevision: number; readonly dependency: string;
    readonly index: DocumentRenderArtifacts["textSearchIndex"] } | null;
  readonly styles: Map<string, StyleEvaluation>;
  readonly resources: PhaseResources;
  readonly searches: Map<string, RetainedSearchProjection>;
}
interface RetainedSearchProjection {
  readonly logicalText: string;
  readonly layout: string;
  readonly projection: TextSearchLayoutProjection;
  readonly owner: RetainedCostOwner;
  lastUsed: number;
}
const PHASES: readonly PhaseName[] = ["computedStyles", "boxTree", "inlineItemStreams", "textSearchIndex",
  "documentLayout", "documentDisplayList", "displayListSpatialIndex", "documentGeometry"];
const RETIREMENT_PHASES = Object.freeze([...PHASES].reverse());
const GEOMETRY_PHASES: readonly PhaseName[] = ["documentLayout", "documentDisplayList", "displayListSpatialIndex", "documentGeometry"];
function phaseResources(): PhaseResources {
  return { computedStyles: new Map(), boxTree: new Map(), inlineItemStreams: new Map(), textSearchIndex: new Map(),
    documentLayout: new Map(), documentDisplayList: new Map(), displayListSpatialIndex: new Map(), documentGeometry: new Map() };
}

const MAX_RETAINED_SEARCH_PROJECTIONS_PER_DOCUMENT = 32;

function mediaKey(document: AttachedDocument, request: DocumentAnalysisRequest): string {
  const environment = request.mediaEnvironment;
  if (!isValidMediaEnvironment(environment)) return "invalid";
  // Conditions, not the raw dimensions, determine cascade participation. Keep
  // diagnostics too: comma-query short circuiting can change reporting even
  // when the final boolean decision is unchanged. This does not publish them.
  return JSON.stringify([environment.mediaType, ...document.program.mediaQueries.map((query) => {
    request.signal?.throwIfAborted();
    const diagnostics: string[] = [];
    const applies = mediaApplies(query, environment, (_detail, identity) => { diagnostics.push(identity); });
    return [applies, diagnostics];
  })]);
}

function layoutKey(styles: DocumentRenderArtifacts["computedStyles"], request: DocumentAnalysisRequest): string {
  const context = request.layoutContext;
  return `${String(context.viewport.width)}x${styles.valueDependencies.usedViewportBlockSize
    ? String(context.viewport.height) : "independent"}`;
}

function textMetricsKey(request: DocumentAnalysisRequest): string {
  const metrics = request.layoutContext.textMeasurer.defaultFontMetrics();
  return [
    textMeasurementDependencyKey(request.layoutContext.textMeasurer, metrics),
    metrics.fontSize,
    metrics.ascent,
    metrics.descent,
    metrics.lineGap,
    metrics.chAdvance,
    request.layoutContext.controlMeasurer.identity,
    request.terminalContext.cellWidthCssPx,
    request.terminalContext.rowHeightCssPx,
    request.terminalContext.ambiguousWidth,
  ].join(":");
}

function dependencyKey(document: AttachedDocument, request: DocumentAnalysisRequest, evaluation: StyleEvaluation): ArtifactDependencyKey {
  const styles = evaluation.snapshot;
  const layoutViewport = layoutKey(styles, request);
  const textMetrics = textMetricsKey(request);
  const computedStyleMap = evaluation.identity;
  const boxTree = `${evaluation.formattingIdentity}:content:${String(document.textStateRevision)}:images:${String(document.imageDimensionsRevision)}`;
  const logicalTextIndex = document.logicalText?.stateRevision === document.textStateRevision
    && document.logicalText.dependency === styles.logicalTextDependency
    ? document.logicalText.key : `${computedStyleMap}:text:${String(document.textStateRevision)}`;
  const documentLayout = [boxTree, layoutViewport, textMetrics].join(":");
  return Object.freeze({
    documentRevision: document.documentRevision,
    stylesheetProgram: document.program.fingerprint,
    stateRevision: document.stateRevision,
    media: evaluation.media, layoutViewport, textMetrics, computedStyleMap, boxTree,
    inlineItemStreams: boxTree, logicalTextIndex, documentLayout,
    documentDisplayList: `${documentLayout}:paint:${computedStyleMap}:images:${String(document.imageMetadataRevision)}`, documentGeometry: documentLayout,
    reporting: evaluation.reporting,
  });
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
  readonly #accounting = new RetainedCostAccounting();
  readonly #maximumCost: number;
  #reservedCost = 0;
  #allocatedPackedBytes = 0;
  #allocatedPackedPages = 0;
  #constructionDepth = 0;
  readonly #instrumentation: RenderArtifactStoreOptions["instrumentation"];
  #clock = 0;
  #evictions = 0;
  #retainedCost = 0;
  #sideCacheScans = 0;

  public constructor(options: RenderArtifactStoreOptions = {}) {
    this.#maximumCost = options.maxRetainedArtifactBytes ?? DEFAULT_MAX_RETAINED_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.#maximumCost) || this.#maximumCost < 1) {
      throw new TypeError("maxRetainedArtifactBytes must be a positive safe integer.");
    }
    this.#instrumentation = options.instrumentation;
  }

  public attach(input: AttachDocumentArtifactsInput): void {
    try { this.#attach(input); } finally { this.#accounting.endBatch(); }
  }

  #attach(input: AttachDocumentArtifactsInput): void {
    input.signal?.throwIfAborted();
    const previous = this.#documents.get(input.documentId);
    if (previous !== undefined) {
      for (const phase of PHASES) this.#retirePhase(previous, phase);
      previous.styles.clear();
      previous.logicalText = null;
      previous.searches.clear();
      previous.queryOwners.clear();
      previous.mutableOwners.clear();
      previous.sideCacheSources.clear();
      this.#clearProgramCaches(previous);
    }
    const program = measured(this.#instrumentation, "stylesheet-program-compilation", () =>
      compileStylesheetProgram({
        document: input.document,
        resources: input.resources,
        ...(input.styleDiagnostics === undefined ? {} : { initialDiagnostics: input.styleDiagnostics }),
        ...(input.budgets?.style === undefined ? {} : { budgets: input.budgets.style }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    );
    const cacheRoots = [program.selectorRuntime, program.substitutedValues, program.propertyValidation];
    const attachmentOwner = measured(this.#instrumentation, "artifact-accounting", () => {
      this.#accounting.immutable(input.document, new Set(), input.signal);
      for (const source of program.sources) this.#accounting.immutable(source.stylesheet, new Set(), input.signal, stylesheetOwnershipRoots(source.stylesheet, input.signal));
      return this.#accounting.immutable(program, new Set(cacheRoots), input.signal);
    });
    // External revisions may restart or already be large after reattachment.
    // Seed semantic freshness from the same monotonic source used by updates.
    const semanticRevision = ++this.#clock;
    const images = input.images ?? Object.freeze([]);
    const attachment: AttachedDocument = {
      attachmentOwner,
      images,
      imagesOwner: this.#accounting.immutable(images, new Set(), input.signal),
      imageDimensionsRevision: 0,
      imageMetadataRevision: 0,
      stateOwner: this.#accounting.immutable(input.state, new Set(), input.signal),
      cacheOwners: cacheRoots.map((root) => this.#accounting.mutable(root, input.signal)),
      queryOwners: new Map(),
      mutableOwners: new Map(),
      sideCacheSources: new Map(),
      documentId: input.documentId,
      documentRevision: input.documentRevision,
      program,
      budgets: input.budgets,
      state: input.state,
      stateRevision: input.stateRevision,
      analysisStateRevision: semanticRevision,
      textStateRevision: semanticRevision,
      logicalText: null,
      styles: new Map(),
      resources: phaseResources(),
      searches: new Map(),
    };
    this.#accounting.endBatch();
    this.#documents.set(input.documentId, attachment);
    try { this.#admit(input.signal); }
    catch (error) {
      this.release(input.documentId);
      if (previous !== undefined) this.#documents.set(input.documentId, previous);
      this.#measureRetainedCost();
      throw error;
    }
  }

  /** Pixel ownership stays in the UI. Known opacity refreshes paint only;
   * only consumed natural geometry retires layout. */
  public updateImages(input: { readonly documentId: string; readonly documentRevision: number;
    readonly images: readonly DocumentImageMetadata[] }): "none" | "paint" | "layout" {
    const document = this.#document(input.documentId, input.documentRevision);
    if (document.images.length === input.images.length && document.images.every((image, index) => {
      const next = input.images[index];
      return next !== undefined && image.id === next.id && image.width === next.width && image.height === next.height
        && image.hasAlpha === next.hasAlpha && image.requestUrl === next.requestUrl
        && image.owners.length === next.owners.length && image.owners.every((owner, ownerIndex) => owner === next.owners[ownerIndex]);
    })) return "none";
    const oldById = new Map(document.images.map((image) => [image.id, image]));
    const nextById = new Map(input.images.map((image) => [image.id, image]));
    const changed = [...new Set([...oldById.keys(), ...nextById.keys()])].filter((id) => {
      const old = oldById.get(id), next = nextById.get(id);
      return (old?.width ?? null) !== (next?.width ?? null) || (old?.height ?? null) !== (next?.height ?? null);
    });
    const layouts = [...document.resources.documentLayout.values()];
    const changesLayout = changed.length > 0 && (layouts.length === 0
      || layouts.some(({ value }) => changed.some((id) => value.imageDimensionsAffectLayout(id))));
    const previous = { images: document.images, imagesOwner: document.imagesOwner,
      imageDimensionsRevision: document.imageDimensionsRevision, imageMetadataRevision: document.imageMetadataRevision };
    document.images = input.images;
    document.imagesOwner = this.#accounting.immutable(input.images);
    if (changesLayout) document.imageDimensionsRevision = ++this.#clock;
    document.imageMetadataRevision = ++this.#clock;
    try { this.#admit(); }
    catch (error) { Object.assign(document, previous); this.#measureRetainedCost(); throw error; }
    if (changesLayout) {
      for (const phase of PHASES) if (phase !== "computedStyles" && phase !== "textSearchIndex") this.#retirePhase(document, phase);
      document.searches.clear();
    } else {
      this.#retirePhase(document, "documentDisplayList");
      this.#retirePhase(document, "displayListSpatialIndex");
    }
    this.#measureRetainedCost();
    return changesLayout ? "layout" : "paint";
  }

  public updateState(input: UpdateDocumentArtifactsStateInput): void {
    const document = this.#document(input.documentId, input.previousDocumentRevision ?? input.documentRevision);
    if (input.previousDocumentRevision !== undefined && input.documentRevision <= input.previousDocumentRevision) {
      throw new RangeError("Document activation revision must advance.");
    }
    if (input.previousDocumentRevision === undefined && input.stateRevision < document.stateRevision) {
      throw new RangeError("Document state revision cannot regress.");
    }
    const previous = { state: document.state, stateOwner: document.stateOwner, documentRevision: document.documentRevision,
      stateRevision: document.stateRevision, analysisStateRevision: document.analysisStateRevision, textStateRevision: document.textStateRevision };
    document.stateOwner = measured(this.#instrumentation, "artifact-accounting", () => this.#accounting.immutable(input.state));
    document.state = input.state;
    document.documentRevision = input.documentRevision;
    document.stateRevision = input.stateRevision;
    const changesTextState = input.changed.has("control-content") || input.changed.has("checked-selected") || input.changed.has("disclosure-open");
    // Internal semantic generations never reset on a new navigation activation.
    if (changesTextState) document.textStateRevision = ++this.#clock;
    const invalidates = changesTextState || [...input.changed].some((change) => {
      const dependency = changedSelectorDependency(change);
      return dependency !== null && document.program.stateDependencies.has(dependency);
    });
    if (invalidates) document.analysisStateRevision = ++this.#clock;
    try { this.#admit(); }
    catch (error) { Object.assign(document, previous); this.#measureRetainedCost(); throw error; }
    if (changesTextState) {
      document.logicalText = null;
      for (const phase of PHASES) if (phase !== "computedStyles") this.#retirePhase(document, phase);
      document.searches.clear();
      this.#measureRetainedCost();
    }
  }

  public analyze(request: DocumentAnalysisRequest): DocumentRenderArtifacts {
    return this.#analyzeTransaction(request, this.#instrumentation);
  }

  #resource<P extends PhaseName>(document: AttachedDocument, phase: P, identity: string): DocumentRenderArtifacts[P] | undefined {
    const entry = document.resources[phase].get(identity);
    if (entry !== undefined) entry.lastUsed = ++this.#clock;
    return entry?.value;
  }

  #retain<P extends PhaseName>(document: AttachedDocument, phase: P, identity: string,
    value: DocumentRenderArtifacts[P], signal?: AbortSignal): void {
    if (document.resources[phase].has(identity)) return;
    const excluded = phase === "textSearchIndex" ? new Set([textSearchQueryCache(value as DocumentRenderArtifacts["textSearchIndex"]).values]) : new Set<object>();
    // Side-cache values own their allocations before downstream immutable geometry
    // can encounter them. No mutable cache may acquire an obsolete layout owner.
    this.#refreshSideCacheCosts(document, signal);
    const owner = measured(this.#instrumentation, "artifact-accounting", () => this.#accounting.immutable(value, excluded, signal));
    document.resources[phase].set(identity, { value, owner, lastUsed: ++this.#clock, pins: 0 });
  }

  #retirePhase(document: AttachedDocument, phase: PhaseName, keep?: string): void {
    for (const [identity, entry] of document.resources[phase]) {
      if (identity === keep || entry.pins !== 0) continue;
      document.resources[phase].delete(identity);
      if (phase === "documentLayout") for (const [searchKey, search] of document.searches) {
        if (search.layout === identity) document.searches.delete(searchKey);
      }
      this.#evictions += 1;
    }
  }

  #analyzeTransaction(
    request: DocumentAnalysisRequest,
    instrumentation: RenderArtifactStoreOptions["instrumentation"],
  ): DocumentRenderArtifacts {
    const document = this.#document(request.documentId, request.documentRevision);
    this.#constructionDepth += 1;
    try { return withPackedAllocationCheck((bytes, page) => {
      if (bytes < 0) { this.#reservedCost += bytes; return; }
      request.signal?.throwIfAborted();
      this.#reservedCost += bytes;
      if (this.#retainedCost + this.#reservedCost > this.#maximumCost) this.#admit(request.signal);
      if (bytes > 0) this.#allocatedPackedBytes += bytes;
      if (page) this.#allocatedPackedPages += 1;
    }, () => this.#analyze(request, instrumentation)); }
    catch (error) {
      this.#clearProgramCaches(document);
      // Failed construction does not restore displaced phase residency.
      document.styles.clear();
      this.#retirePhase(document, "computedStyles");
      this.#measureRetainedCost();
      throw error;
    } finally { this.#constructionDepth -= 1; this.#accounting.endBatch(); }
  }

  #clearProgramCaches(document: AttachedDocument): void {
    document.program.selectorRuntime.clear();
    document.program.substitutedValues.clear();
    document.program.propertyValidation.clear();
    this.#refreshProgramCosts(document);
  }

  #analyze(
    request: DocumentAnalysisRequest,
    instrumentation: RenderArtifactStoreOptions["instrumentation"],
  ): DocumentRenderArtifacts {
    const document = this.#document(request.documentId, request.documentRevision);
    request.signal?.throwIfAborted();
    const media = mediaKey(document, request);
    const environmentMatches = (entry: StyleEvaluation): boolean => entry.media === media
      && (!entry.snapshot.valueDependencies.computedViewportInlineSize
        || entry.snapshot.environment.viewportWidthCssPx === request.mediaEnvironment.viewportWidthCssPx)
      && (!entry.snapshot.valueDependencies.computedViewportBlockSize
        || entry.snapshot.environment.viewportHeightCssPx === request.mediaEnvironment.viewportHeightCssPx);
    const previous = [...document.styles.values()].find(environmentMatches);
    let evaluation = previous;
    if (evaluation === undefined || evaluation.stateRevision !== document.analysisStateRevision) {
      const snapshot = measured(instrumentation, "computed-style-resolution", () => resolveStyles({
        program: document.program, state: document.state, environment: request.mediaEnvironment,
        ...(instrumentation === undefined ? {} : { instrumentation: {
          record: (stage: "selector-matching" | "custom-property-substitution", elapsed: number) => { instrumentation.record(stage, elapsed); },
        } }),
        ...(document.budgets?.style === undefined ? {} : { budgets: document.budgets.style }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }));
      const change = previous === undefined ? null : compareStyleSnapshots(previous.snapshot, snapshot);
      const identity = previous !== undefined && change?.effectiveChanged === false ? previous.identity : `style:${String(++this.#clock)}`;
      const reporting = previous !== undefined && change?.reportingChanged === false ? previous.reporting : `report:${String(++this.#clock)}`;
      const formattingIdentity = previous !== undefined && (change?.effectiveChanged === false || change?.backgroundOnly === true)
        ? previous.formattingIdentity : identity;
      evaluation = { identity, formattingIdentity, reporting, snapshot, media, stateRevision: document.analysisStateRevision, lastUsed: ++this.#clock };
      if (previous !== undefined) {
        document.styles.delete(previous.identity);
        document.resources.computedStyles.delete(previous.identity);
      }
      document.styles.set(identity, evaluation);
      // A style slot owns only its current reporting snapshot, never every state revision.
      document.resources.computedStyles.delete(identity);
      this.#retain(document, "computedStyles", identity, snapshot, request.signal);
      this.#refreshProgramCosts(document, request.signal);
      while (document.styles.size > 4) {
        const oldest = [...document.styles.values()].reduce((a, b) => a.lastUsed < b.lastUsed ? a : b);
        document.styles.delete(oldest.identity);
        document.resources.computedStyles.delete(oldest.identity);
      }
    }
    evaluation.lastUsed = ++this.#clock;
    const computedStyles = evaluation.snapshot;
    const key = dependencyKey(document, request, evaluation);
    const identities: Record<PhaseName, string> = { computedStyles: key.computedStyleMap, boxTree: key.boxTree,
      inlineItemStreams: key.inlineItemStreams, textSearchIndex: key.logicalTextIndex, documentLayout: key.documentLayout,
      documentDisplayList: key.documentDisplayList, displayListSpatialIndex: key.documentDisplayList, documentGeometry: key.documentGeometry };
    const pinned: PhaseResource<object>[] = [];
    for (const phase of PHASES) {
      const entry = document.resources[phase].get(identities[phase]);
      if (entry !== undefined) { entry.pins += 1; pinned.push(entry); }
    }
    const created: { phase: PhaseName; identity: string }[] = [];
    const retain = <P extends PhaseName>(phase: P, value: DocumentRenderArtifacts[P]): DocumentRenderArtifacts[P] => {
      const identity = identities[phase];
      if (!document.resources[phase].has(identity)) {
        this.#retain(document, phase, identity, value, request.signal);
        const entry = document.resources[phase].get(identity);
        if (entry === undefined) throw new Error("Missing newly retained phase resource.");
        entry.pins += 1; pinned.push(entry);
        created.push({ phase, identity });
        // The phase now owns its packed capacities and metadata; reservation is
        // exchanged for the measured owner while the new phase remains pinned.
        finishPackedConstructionPhase();
        this.#reservedCost = 0;
        this.#admit(request.signal);
      }
      return value;
    };
    let admitted = false;
    try {
      const replacesLayout = !document.resources.documentLayout.has(key.documentLayout);
      const replacesPaint = !document.resources.documentDisplayList.has(key.documentDisplayList);
      if (replacesLayout || replacesPaint) {
        const phases = replacesLayout ? GEOMETRY_PHASES : ["documentDisplayList", "displayListSpatialIndex"] as const;
        for (const phase of phases) this.#retirePhase(document, phase, identities[phase]);
        if (replacesLayout) for (const phase of ["boxTree", "inlineItemStreams", "textSearchIndex"] as const) this.#retirePhase(document, phase, identities[phase]);
        this.#admit(request.signal);
      }
      const boxTree = this.#resource(document, "boxTree", key.boxTree) ?? retain("boxTree", measured(instrumentation, "box-tree-construction", () => buildFormattingTree({
        document: document.program.document, state: document.state, styles: computedStyles, images: document.images,
        ...(document.budgets?.formatting === undefined ? {} : { budgets: document.budgets.formatting }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })));
      const inlineItemStreams = this.#resource(document, "inlineItemStreams", key.inlineItemStreams) ?? retain("inlineItemStreams",
        measured(instrumentation, "inline-item-stream-construction", () => buildInlineItemStreamSet(boxTree, request.signal)));
      const textSearchIndex = this.#resource(document, "textSearchIndex", key.logicalTextIndex) ?? retain("textSearchIndex",
        document.logicalText?.key === key.logicalTextIndex ? document.logicalText.index : measured(instrumentation, "logical-search-index-construction", () => buildTextSearchIndex(boxTree, inlineItemStreams, request.signal)));
      const initial = request.layoutContext.initialContainingBlock;
      const documentLayout = this.#resource(document, "documentLayout", key.documentLayout) ?? retain("documentLayout",
        measured(instrumentation, "normal-flow-layout", () => buildLayoutFragmentTree({ formatting: boxTree, inlineItemStreams,
          context: { ...request.layoutContext, scrollport: cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), initial.width, initial.height),
            ...(document.budgets?.layout === undefined ? {} : { budgets: document.budgets.layout }) },
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })));
      const documentDisplayList = this.#resource(document, "documentDisplayList", key.documentDisplayList) ?? retain("documentDisplayList",
        measured(instrumentation, "document-display-list-construction", () => buildDocumentDisplayList({ layout: documentLayout, styles: computedStyles, images: document.images,
          context: { ...request.terminalContext, colorDepth: 24, ...(document.budgets?.terminal === undefined ? {} : { budgets: document.budgets.terminal }) },
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })));
      const displayListSpatialIndex = this.#resource(document, "displayListSpatialIndex", key.documentDisplayList) ?? retain("displayListSpatialIndex",
        measured(instrumentation, "display-list-spatial-index-construction", () => buildDisplayListSpatialIndex(documentDisplayList, request.signal)));
      const documentGeometry = this.#resource(document, "documentGeometry", key.documentGeometry) ?? retain("documentGeometry",
        measured(instrumentation, "document-geometry-index-construction", () => buildDocumentGeometryIndex(documentDisplayList, request.signal)));
      this.#reservedCost = 0;
      this.#admit(request.signal);
      request.signal?.throwIfAborted();
      document.logicalText = { key: key.logicalTextIndex, stateRevision: document.textStateRevision,
        dependency: computedStyles.logicalTextDependency, index: textSearchIndex };
      admitted = true;
      return Object.freeze({ key, stylesheetProgram: document.program, computedStyles, boxTree, inlineItemStreams,
        textSearchIndex, documentLayout, documentDisplayList, displayListSpatialIndex, documentGeometry, retainedCost: this.#retainedCost });
    } finally {
      this.#reservedCost = 0;
      for (const entry of pinned) entry.pins -= 1;
      if (!admitted) for (const { phase, identity } of created) document.resources[phase].delete(identity);
    }
  }

  public renderViewport(request: ViewportRenderRequest): RetainedViewportRenderResult {
    return this.withViewportArtifacts(request, (viewport) => viewport);
  }

  /** Compose and extract summaries while exactly the requested phase resources are pinned. */
  public withViewportArtifacts<T>(request: ViewportRenderRequest,
    operation: (viewport: RetainedViewportRenderResult, artifacts: DocumentRenderArtifacts) => T): T {
    const localMetrics = new RenderStageMetrics();
    const instrumentation = {
      record: (identity, elapsed) => {
        localMetrics.record(identity, elapsed);
        this.#instrumentation?.record(identity, elapsed);
      },
    } satisfies NonNullable<RenderArtifactStoreOptions["instrumentation"]>;
    const artifacts = this.#analyzeTransaction({
      ...request,
      ...(request.analysisSignal === undefined ? {} : { signal: request.analysisSignal }),
    }, instrumentation);
    const unpin = this.#pinArtifacts(this.#document(request.documentId, request.documentRevision), artifacts);
    try {
      const terminalBudgets = this.#document(
        request.documentId,
        request.documentRevision,
      ).budgets?.terminal;
      const record = <T>(stage: Parameters<typeof measured>[1], operation: () => T): T => measured(
        instrumentation,
        stage,
        operation,
      );
      const revealQuery = request.window.reveal !== undefined && "query" in request.window.reveal ? request.window.reveal.query : null;
      const query = request.searchQuery ?? revealQuery;
      const searchProjection = query === null ? null : this.#searchProjection(
        this.#document(request.documentId, request.documentRevision), artifacts, query, 10_000, request.signal,
      );
      const displayList = record("viewport-display-list-construction", () => buildViewportDisplayList({
        documentDisplayList: artifacts.documentDisplayList,
        spatialIndex: artifacts.displayListSpatialIndex,
        searchProjection,
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
        searchProjection,
        truncations: cells.truncations,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }));
      const document = this.#document(request.documentId, request.documentRevision);
      const viewport = Object.freeze({
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
      return operation(viewport, artifacts);
    } finally {
      unpin();
      this.#measureRetainedCost();
    }
  }

  #pinArtifacts(document: AttachedDocument, artifacts: DocumentRenderArtifacts): () => void {
    const pins: PhaseResource<object>[] = [];
    for (const phase of PHASES) for (const entry of document.resources[phase].values()) {
      if (entry.value === artifacts[phase]) { entry.pins += 1; pins.push(entry); }
    }
    return () => { for (const entry of pins) entry.pins -= 1; };
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
    const unpin = this.#pinArtifacts(this.#document(request.documentId, request.documentRevision), artifacts);
    try {
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
      documentRevision: request.documentRevision,
      stateRevision: this.#document(request.documentId, request.documentRevision).stateRevision,
      layoutRevision: artifacts.key.documentLayout,
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
    } finally { unpin(); }
  }

  public release(documentId: string): void {
    const document = this.#documents.get(documentId);
    if (document === undefined) return;
    document.program.propertyValidation.clear();
    document.program.substitutedValues.clear();
    document.program.selectorRuntime.clear();
    for (const phase of PHASES) document.resources[phase].clear();
    document.styles.clear();
    document.mutableOwners.clear();
    document.sideCacheSources.clear();
    document.searches.clear();
    document.logicalText = null;
    document.queryOwners.clear();
    this.#documents.delete(documentId);
    this.#measureRetainedCost();
  }

  public dispose(): void {
    for (const id of [...this.#documents.keys()]) this.release(id);
  }

  public metrics(): RenderArtifactStoreMetrics {
    this.#measureRetainedCost();
    const phaseOwnedBytes = Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<PhaseName, number>;
    let retainedAnalyses = 0;
    let retainedResources = 0;
    let pinnedResources = 0;
    const textAnalysisWork = { intrinsicCalls: 0, intrinsicReuses: 0, intrinsicAnalyzedUnits: 0, inlineBuilds: 0, inlineReuses: 0 };
    for (const document of this.#documents.values()) {
      retainedAnalyses += document.resources.documentLayout.size;
      for (const { value } of document.resources.documentLayout.values()) {
        for (const key of Object.keys(textAnalysisWork) as (keyof typeof textAnalysisWork)[]) textAnalysisWork[key] += value.textAnalysisWork[key];
      }
      for (const phase of PHASES) for (const resource of document.resources[phase].values()) {
        phaseOwnedBytes[phase] += resource.owner.bytes;
        retainedResources += 1;
        if (resource.pins > 0) pinnedResources += 1;
      }
    }
    return Object.freeze({
      attachedDocuments: this.#documents.size,
      textAnalysisWork: Object.freeze(textAnalysisWork),
      phaseOwnedBytes: Object.freeze(phaseOwnedBytes),
      retainedAnalyses,
      retainedResources,
      pinnedResources,
      reservedCost: this.#reservedCost,
      allocatedPackedBytes: this.#allocatedPackedBytes,
      allocatedPackedPages: this.#allocatedPackedPages,
      sideCacheScans: this.#sideCacheScans,
      retainedCost: this.#retainedCost,
      evictions: this.#evictions,
      accountedAllocations: this.#accounting.measuredAllocations,
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
    signal?.throwIfAborted();
    const bounded = query.slice(0, 1_024);
    const identity = `${artifacts.key.logicalTextIndex}\u0000${artifacts.key.documentLayout}\u0000${String(limit)}\u0000${bounded}`;
    const retained = document.searches.get(identity) ?? [...document.searches].find(([, value]) =>
      value.logicalText === artifacts.key.logicalTextIndex && value.layout === artifacts.key.documentLayout && value.projection.query === bounded
        && !value.projection.truncated && value.projection.matches.length <= limit)?.[1];
    if (retained !== undefined) {
      retained.lastUsed = ++this.#clock;
      return retained.projection;
    }
    try {
      const projection = measured(this.#instrumentation, "search-layout-projection", () => projectTextSearchToLayout(
        artifacts.textSearchIndex, artifacts.documentLayout, bounded, limit, signal,
      ));
      const owner = measured(this.#instrumentation, "artifact-accounting", () => {
        this.#refreshQueryCosts(document, artifacts.textSearchIndex, signal);
        return this.#accounting.immutable(projection, new Set(), signal);
      });
      signal?.throwIfAborted();
      document.searches.set(identity, { projection, owner, logicalText: artifacts.key.logicalTextIndex, layout: artifacts.key.documentLayout, lastUsed: ++this.#clock });
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
      this.#admit(signal);
      return projection;
    } catch (error) {
      document.searches.delete(identity);
      clearTextSearchQueryCache(artifacts.textSearchIndex);
      this.#refreshQueryCosts(document, artifacts.textSearchIndex);
      this.#measureRetainedCost();
      throw error;
    } finally { this.#accounting.endBatch(); }
  }

  #refreshProgramCosts(document: AttachedDocument, signal?: AbortSignal): void {
    document.cacheOwners = [document.program.selectorRuntime, document.program.substitutedValues,
      document.program.propertyValidation].map((root) => this.#accounting.mutable(root, signal));
  }

  #refreshQueryCosts(document: AttachedDocument, index: DocumentRenderArtifacts["textSearchIndex"], signal?: AbortSignal): void {
    const cache = textSearchQueryCache(index);
    if (document.queryOwners.get(index)?.revision === cache.revision) return;
    for (const result of cache.values.values()) this.#accounting.immutable(result, new Set(), signal);
    document.queryOwners.set(index, {
      owner: this.#accounting.mutable(cache.values, signal), revision: cache.revision,
    });
  }

  #refreshSideCacheCosts(document: AttachedDocument, signal?: AbortSignal): void {
    const roots: object[] = [...document.resources.boxTree.values()].map(({ value }) => value);
    for (const { value } of document.resources.inlineItemStreams.values()) roots.push(value);
    if (roots.length === document.sideCacheSources.size
      && roots.every((root) => document.sideCacheSources.get(root) === retainedSideCacheRevision(root))) return;
    this.#sideCacheScans += 1;
    const active = new Set<object>();
    for (const root of roots) for (const cache of retainedSideCaches(root)) {
      signal?.throwIfAborted();
      active.add(cache);
      if (document.mutableOwners.get(cache)?.revision === cache.revision) continue;
      for (const value of cache.values()) {
        if (value !== null && typeof value === "object") this.#accounting.immutable(value, new Set(), signal);
      }
      document.mutableOwners.set(cache, { owner: this.#accounting.mutable(cache, signal), revision: cache.revision });
    }
    for (const cache of document.mutableOwners.keys()) if (!active.has(cache)) document.mutableOwners.delete(cache);
    document.sideCacheSources.clear();
    for (const root of roots) document.sideCacheSources.set(root, retainedSideCacheRevision(root));
  }

  #pruneQueryOwners(document: AttachedDocument): void {
    const retained = new Set([...document.resources.textSearchIndex.values()].map(({ value }) => value));
    if (document.logicalText !== null) retained.add(document.logicalText.index);
    for (const index of document.queryOwners.keys()) if (!retained.has(index)) document.queryOwners.delete(index);
  }

  #measureRetainedCost(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const owners: RetainedCostOwner[] = [];
    let bookkeeping = 0;
    for (const document of this.#documents.values()) {
      this.#pruneQueryOwners(document);
      this.#refreshSideCacheCosts(document, signal);
      const indexes = new Set([...document.resources.textSearchIndex.values()].map(({ value }) => value));
      if (document.logicalText !== null) indexes.add(document.logicalText.index);
      for (const index of indexes) this.#refreshQueryCosts(document, index, signal);
      owners.push(document.attachmentOwner, document.stateOwner, document.imagesOwner, ...document.cacheOwners,
        ...[...document.queryOwners.values()].map((entry) => entry.owner));
      if (document.logicalText !== null) owners.push(this.#accounting.immutable(document.logicalText.index));
      for (const phase of PHASES) for (const entry of document.resources[phase].values()) owners.push(entry.owner);
      owners.push(...[...document.mutableOwners.values()].map((entry) => entry.owner));
      for (const search of document.searches.values()) owners.push(search.owner);
      // Covers store records, dependency keys, map entries and owner ledger records conservatively.
      bookkeeping += 2048 + document.documentId.length * 2;
      for (const phase of PHASES) for (const identity of document.resources[phase].keys()) bookkeeping += 2048 + identity.length * 2;
      bookkeeping += document.styles.size * 1024 + document.mutableOwners.size * 256 + document.sideCacheSources.size * 128;
      for (const identity of document.searches.keys()) bookkeeping += 1024 + identity.length * 2;
    }
    this.#retainedCost = bookkeeping + this.#accounting.total(owners);
    if (this.#constructionDepth === 0) this.#accounting.endBatch();
  }

  /** Expensive diagnostic oracle for tests and explicit qualification, never used for admission. */
  public recountRetainedCost(): number {
    return estimatedRetainedCost([...this.#documents.values()].map((document) => ({
      program: document.program, state: document.state, images: document.images, budgets: document.budgets,
      logicalText: document.logicalText,
      queryIndexes: [...document.queryOwners.keys()],
      styles: [...document.styles.values()],
      resources: PHASES.flatMap((phase) => [...document.resources[phase].values()].map(({ value }) => value)),
      searches: [...document.searches.values()].map(({ projection }) => projection),
    })));
  }

  #admit(signal?: AbortSignal): void {
    measured(this.#instrumentation, "artifact-admission", () => { this.#admitOwners(signal); });
  }

  #admitOwners(signal?: AbortSignal): void {
    this.#measureRetainedCost(signal);
    let trimmed = false;
    while (this.#retainedCost + this.#reservedCost > this.#maximumCost) {
      if (!trimmed) {
        // Accelerator pressure shares the same admission policy. Clearing the selector
        // runtime also invalidates its computed-style incremental baseline.
        for (const document of this.#documents.values()) this.#clearProgramCaches(document);
        trimmed = true;
        this.#measureRetainedCost(signal);
        continue;
      }
      let oldest: { document: AttachedDocument; phase: PhaseName; identity: string; lastUsed: number } | null = null;
      for (const phase of RETIREMENT_PHASES) {
        for (const document of this.#documents.values()) for (const [identity, entry] of document.resources[phase]) {
          if (entry.pins !== 0) continue;
          if (oldest === null || (oldest.phase === phase && entry.lastUsed < oldest.lastUsed)) oldest = { document, phase, identity, lastUsed: entry.lastUsed };
        }
      }
      if (oldest === null) throw new RenderBudgetExceededError("retained-cost", this.#retainedCost + this.#reservedCost, this.#maximumCost);
      oldest.document.resources[oldest.phase].delete(oldest.identity);
      if (oldest.phase === "computedStyles") oldest.document.styles.delete(oldest.identity);
      if (oldest.phase === "textSearchIndex" && oldest.document.logicalText?.key === oldest.identity) oldest.document.logicalText = null;
      for (const [identity, search] of oldest.document.searches) {
        if ((oldest.phase === "documentLayout" && search.layout === oldest.identity)
          || (oldest.phase === "textSearchIndex" && search.logicalText === oldest.identity)) oldest.document.searches.delete(identity);
      }
      this.#evictions += 1;
      this.#measureRetainedCost(signal);
    }
  }
}
