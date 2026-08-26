import type { DocumentState, IndexedWebDocumentSnapshot } from "../document/index.js";
import { buildFormattingTree, type FormattingBudgets, type FormattingTree } from "./formatting/index.js";
import {
  buildLayoutFragmentTree,
  cssMultiply,
  cssPx,
  type LayoutBudgets,
  type LayoutContext,
  type LayoutFragmentTree
} from "./layout/index.js";
import { buildTextSearchIndex, type TextSearchIndex } from "./search/index.js";
import {
  buildInlineItemStreamSet,
  type InlineItemStreamSet
} from "./text/index.js";
import {
  resolveStyles, type MediaEnvironment, type StyleBudgets, type StyleDiagnostic,
  type StylesheetResource, type StyleSnapshot
} from "./style/index.js";
import {
  buildTerminalDisplayList, rasterizeTerminalDisplayList, type TerminalDisplayList,
  type TerminalPaintBudgets, type TerminalRenderContext, type TerminalRenderResult
} from "./terminal/index.js";

export interface RenderPipelineBudgets {
  readonly style?: Partial<StyleBudgets>;
  readonly formatting?: Partial<FormattingBudgets>;
  readonly layout?: Partial<LayoutBudgets>;
  readonly terminal?: Partial<TerminalPaintBudgets>;
}

export interface RenderDocumentInput {
  readonly document: IndexedWebDocumentSnapshot;
  readonly state: DocumentState;
  readonly resources: readonly StylesheetResource[];
  readonly styleDiagnostics?: readonly StyleDiagnostic[];
  readonly mediaEnvironment: MediaEnvironment;
  readonly layoutContext: LayoutContext;
  readonly terminalContext: TerminalRenderContext;
  readonly budgets?: RenderPipelineBudgets;
  readonly signal?: AbortSignal;
}

/** Internal end-to-end render-pipeline result. These subsystem contracts are not root exports. */
export interface RenderPipelineResult {
  readonly styles: StyleSnapshot;
  readonly formatting: FormattingTree;
  readonly inlineItemStreams: InlineItemStreamSet;
  readonly textSearchIndex: TextSearchIndex;
  readonly layout: LayoutFragmentTree;
  readonly displayList: TerminalDisplayList;
  readonly terminal: TerminalRenderResult;
}

function coherentRenderingRequest(input: RenderDocumentInput): boolean {
  try {
    const mediaWidth = cssPx(input.mediaEnvironment.viewportWidthCssPx);
    const mediaHeight = cssPx(input.mediaEnvironment.viewportHeightCssPx);
    const terminalWidth = cssMultiply(input.terminalContext.cellWidthCssPx, input.terminalContext.columns);
    const terminalHeight = cssMultiply(input.terminalContext.rowHeightCssPx, input.terminalContext.rows);
    const initial = input.layoutContext.initialContainingBlock;
    const scrollport = input.layoutContext.scrollport;
    return mediaWidth === input.layoutContext.viewport.width
      && mediaHeight === input.layoutContext.viewport.height
      && terminalWidth === mediaWidth
      && terminalHeight === mediaHeight
      && initial.x === 0
      && initial.y === 0
      && initial.width === mediaWidth
      && initial.height === mediaHeight
      && Number.isSafeInteger(scrollport.x)
      && Number.isSafeInteger(scrollport.y)
      && scrollport.width === mediaWidth
      && scrollport.height === mediaHeight;
  } catch {
    return false;
  }
}

export function renderDocument(input: RenderDocumentInput): RenderPipelineResult {
  input.signal?.throwIfAborted();
  if (!coherentRenderingRequest(input)) {
    throw new RangeError("Media, layout, initial containing block, and terminal viewports must describe one rendering request.");
  }
  const styles = resolveStyles({
    document: input.document,
    state: input.state,
    resources: input.resources,
    ...(input.styleDiagnostics === undefined ? {} : { initialDiagnostics: input.styleDiagnostics }),
    environment: input.mediaEnvironment,
    ...(input.budgets?.style === undefined ? {} : { budgets: input.budgets.style }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const formatting = buildFormattingTree({
    document: input.document,
    state: input.state,
    styles,
    ...(input.budgets?.formatting === undefined ? {} : { budgets: input.budgets.formatting }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const inlineItemStreams = buildInlineItemStreamSet(formatting, input.signal);
  const textSearchIndex = buildTextSearchIndex(formatting, inlineItemStreams, input.signal);
  const layout = buildLayoutFragmentTree({
    formatting,
    inlineItemStreams,
    context: {
      ...input.layoutContext,
      ...(input.budgets?.layout === undefined ? {} : { budgets: input.budgets.layout })
    },
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const displayList = buildTerminalDisplayList({
    layout,
    context: {
      ...input.terminalContext,
      ...(input.budgets?.terminal === undefined ? {} : { budgets: input.budgets.terminal })
    },
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const terminal = rasterizeTerminalDisplayList({
    displayList,
    textSearchIndex,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return Object.freeze({ styles, formatting, inlineItemStreams, textSearchIndex, layout, displayList, terminal });
}
