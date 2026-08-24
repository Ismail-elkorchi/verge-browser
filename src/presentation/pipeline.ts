import type { DocumentState, WebDocumentSnapshotView } from "../document/index.js";
import { buildFormattingTree, type FormattingBudgets, type FormattingTree } from "./formatting/index.js";
import { resolveStyles, type StyleBudgets, type StyleDiagnostic, type StylesheetResource, type StyleSnapshot } from "./style/index.js";
import {
  buildFragmentTree,
  type FragmentBudgets,
  type FragmentTree,
  type TerminalProfile,
  type TerminalTextMeasurer,
  type TerminalViewport
} from "./terminal/index.js";

export interface PresentationBudgets {
  readonly style?: Partial<StyleBudgets>;
  readonly formatting?: Partial<FormattingBudgets>;
  readonly fragments?: Partial<FragmentBudgets>;
}

export interface PresentDocumentInput {
  readonly document: WebDocumentSnapshotView;
  readonly state: DocumentState;
  readonly resources: readonly StylesheetResource[];
  readonly styleDiagnostics?: readonly StyleDiagnostic[];
  readonly viewport: TerminalViewport;
  readonly measurer: TerminalTextMeasurer;
  readonly profile: TerminalProfile;
  readonly budgets?: PresentationBudgets;
  readonly signal?: AbortSignal;
}

/** Internal end-to-end presentation result. These subsystem contracts are not root exports. */
export interface DocumentPresentation {
  readonly styles: StyleSnapshot;
  readonly formatting: FormattingTree;
  readonly fragments: FragmentTree;
}

export function presentDocument(input: PresentDocumentInput): DocumentPresentation {
  input.signal?.throwIfAborted();
  const styles = resolveStyles({
    document: input.document,
    state: input.state,
    resources: input.resources,
    ...(input.styleDiagnostics === undefined ? {} : { initialDiagnostics: input.styleDiagnostics }),
    environment: {
      viewportWidthPx: input.viewport.columns * input.profile.cellWidthPx,
      viewportHeightPx: input.viewport.rows * input.profile.rowHeightPx,
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: true
    },
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
  const fragments = buildFragmentTree({
    formatting,
    viewport: input.viewport,
    measurer: input.measurer,
    profile: input.profile,
    ...(input.budgets?.fragments === undefined ? {} : { budgets: input.budgets.fragments }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return Object.freeze({ styles, formatting, fragments });
}
