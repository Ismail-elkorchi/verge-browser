import type { DocumentState, IndexedWebDocumentSnapshot } from "../document/index.js";
import { buildFormattingTree, type FormattingBudgets, type FormattingTree } from "./formatting/index.js";
import { buildLayoutFragmentTree, type LayoutBudgets, type LayoutContext, type LayoutFragmentTree } from "./layout/index.js";
import { buildTextSearchIndex, type TextSearchIndex } from "./search/index.js";
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
}

/** Internal end-to-end render-pipeline result. These subsystem contracts are not root exports. */
export interface RenderPipelineResult {
  readonly styles: StyleSnapshot;
  readonly formatting: FormattingTree;
  readonly textSearchIndex: TextSearchIndex;
  readonly layout: LayoutFragmentTree;
  readonly displayList: TerminalDisplayList;
  readonly terminal: TerminalRenderResult;
}

export function renderDocument(input: RenderDocumentInput): RenderPipelineResult {
  input.terminalContext.signal?.throwIfAborted();
  const styles = resolveStyles({
    document: input.document,
    state: input.state,
    resources: input.resources,
    ...(input.styleDiagnostics === undefined ? {} : { initialDiagnostics: input.styleDiagnostics }),
    environment: input.mediaEnvironment,
    ...(input.budgets?.style === undefined ? {} : { budgets: input.budgets.style }),
    ...(input.terminalContext.signal === undefined ? {} : { signal: input.terminalContext.signal })
  });
  const formatting = buildFormattingTree({
    document: input.document,
    state: input.state,
    styles,
    ...(input.budgets?.formatting === undefined ? {} : { budgets: input.budgets.formatting }),
    ...(input.terminalContext.signal === undefined ? {} : { signal: input.terminalContext.signal })
  });
  const textSearchIndex = buildTextSearchIndex(formatting, input.terminalContext.signal);
  const layout = buildLayoutFragmentTree({
    formatting,
    searchIndex: textSearchIndex,
    context: {
      ...input.layoutContext,
      ...(input.budgets?.layout === undefined ? {} : { budgets: input.budgets.layout })
    }
  });
  const displayList = buildTerminalDisplayList({
    layout,
    context: {
      ...input.terminalContext,
      ...(input.budgets?.terminal === undefined ? {} : { budgets: input.budgets.terminal })
    }
  });
  const terminal = rasterizeTerminalDisplayList({ displayList });
  return Object.freeze({ styles, formatting, textSearchIndex, layout, displayList, terminal });
}
