import { renderElementFrame, renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { runTui, TuiRunError } from "@ismail-elkorchi/terminal-ui/tui";
import type { DiagnosticOccurrence, TerminalDiagnosticValue } from "@ismail-elkorchi/terminal-ui";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

import type { BrowserSession } from "../app/session.js";
import type { BrowserStore } from "../app/storage.js";
import type { RenderInstrumentation } from "../presentation/renderer/index.js";
import type { TerminalSize } from "@ismail-elkorchi/terminal-ui/host";
import type { BrowserServices } from "./services.js";
import { createBrowserApp, createBrowserInitialState } from "./app.js";
import { BrowserController } from "./browser-controller.js";
import { browserRenderPreferences, documentContentColumns, documentScrollRow } from "./document-layout.js";
import { browserView } from "./view.js";

export interface BrowserTuiOptions {
  readonly store: BrowserStore;
  readonly services: BrowserServices;
  readonly createSession: (httpSession: HttpSessionAdapter) => BrowserSession;
  readonly searchUrlTemplate?: string;
  readonly downloadDirectory?: string;
  readonly downloadMaxBytes?: number;
  readonly restoreWorkspace?: boolean;
  readonly instrumentation?: RenderInstrumentation;
}

export async function prepareBrowserTui(initialTarget: string, options: BrowserTuiOptions) {
  const controller = new BrowserController(options);
  try {
    const workspace = options.restoreWorkspace === true ? controller.workspace() : null;
    const storedDocuments = workspace?.documents ?? [];
    const documents = [];
    if (storedDocuments.length === 0) {
      documents.push(controller.placeholder(initialTarget));
    } else {
      for (const document of storedDocuments) {
        documents.push(controller.placeholder(document.url, document.scrollAnchor));
      }
    }
    const state = createBrowserInitialState(
      documents,
      workspace?.activeDocumentIndex ?? 0,
      controller,
      workspace?.sidePanel ?? null
    );
    return {
      controller,
      state,
      app: createBrowserApp(state, controller, options.instrumentation)
    };
  } catch (error) {
    await controller.close();
    throw error;
  }
}

export async function runBrowserTui(initialTarget: string, options: BrowserTuiOptions): Promise<void> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  try {
    const activeTab = prepared.state.documents[prepared.state.activeDocumentIndex];
    await runTui(prepared.app, {
      initialFocus: activeTab !== undefined
        && (activeTab.kind === "ready" ? activeTab.snapshot.finalUrl : activeTab.requestedUrl) === "about:newtab"
        ? { kind: "element", elementId: "browser-omnibox" }
        : {
          kind: "element",
          elementId: `browser-${prepared.state.documents[prepared.state.activeDocumentIndex]?.id ?? ""}`
        }
    });
  } catch (error) {
    if (error instanceof TuiRunError) {
      throw new Error(browserTuiFailureMessage(error.exit.diagnostics), { cause: error });
    }
    throw error;
  } finally {
    await prepared.controller.close();
  }
}

export function browserTuiFailureMessage(diagnostics: readonly DiagnosticOccurrence[]): string {
  let failure: DiagnosticOccurrence | undefined;
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const item = diagnostics[index];
    if (item?.diagnostic.severity === "fatal" || item?.diagnostic.severity === "error") {
      failure = item;
      break;
    }
  }
  if (failure === undefined) return "The terminal UI stopped because of a runtime error.";
  const cause = diagnosticCauseMessage(failure.diagnostic.cause);
  return [failure.diagnostic.message, cause, failure.diagnostic.hint]
    .filter((part, index, parts): part is string =>
      part !== undefined
      && part.length > 0
      && parts.indexOf(part) === index
    )
    .join(" ");
}

function diagnosticCauseMessage(cause: TerminalDiagnosticValue | undefined): string | undefined {
  if (typeof cause === "string") return cause;
  if (cause === null || cause === undefined || Array.isArray(cause) || typeof cause !== "object") {
    return undefined;
  }
  const message = (cause as Readonly<Record<string, TerminalDiagnosticValue>>)["message"];
  return typeof message === "string" ? message : undefined;
}

export async function renderBrowserOnce(
  initialTarget: string,
  options: BrowserTuiOptions,
  terminalSize: TerminalSize
): Promise<string> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  try {
    const selectedTab = prepared.state.documents[prepared.state.activeDocumentIndex] ?? prepared.state.documents[0];
    if (selectedTab === undefined) throw new Error("One-shot rendering requires an open document.");
    const selected = selectedTab.kind === "ready"
      ? selectedTab
      : await prepared.controller.restorePlaceholder(selectedTab);
    const pageColumns = prepared.state.sidePanel !== null && terminalSize.columns >= 100
      ? terminalSize.columns - 41
      : terminalSize.columns;
    const viewportRows = Math.max(1, terminalSize.rows - (prepared.state.findBar === null ? 3 : 4));
    const viewportRevision = selected.rendering.requestedViewportRevision + 1;
    const payload = await prepared.controller.renderViewport(selected, viewportRevision, {
      columns: documentContentColumns(Math.max(1, pageColumns - 1)),
      rows: viewportRows,
      scrollRow: documentScrollRow(selected),
      overscanBefore: Math.min(6, viewportRows),
      overscanAfter: Math.min(12, viewportRows),
      preferences: browserRenderPreferences(),
      searchQuery: selected.search?.query ?? null,
    });
    const incomplete = payload.cellBuffer.outcome.status === "rejected"
      ? [`cell-buffer.${payload.cellBuffer.outcome.reason}`]
      : payload.cellBuffer.outcome.status === "truncated"
        ? payload.cellBuffer.outcome.truncations.map((entry) =>
          `terminal.${entry.budget}=${String(entry.limit)}`
        )
        : [];
    if (incomplete.length > 0) {
      throw new Error(`One-shot rendering was incomplete (${incomplete.join(", ")}).`);
    }
    const renderedDocument = {
      ...selected,
      rendering: {
        ...selected.rendering,
        status: "ready" as const,
        requestedViewportRevision: viewportRevision,
        committedViewportRevision: viewportRevision,
        viewport: payload,
        summary: payload.summary,
        error: null,
      },
    };
    const renderedState = {
      ...prepared.state,
      documents: prepared.state.documents.map((document) =>
        document.id === selected.id ? renderedDocument : document
      ),
    };
    return renderFramePlain(renderElementFrame(
      browserView(renderedState, { terminalSize }),
      terminalSize
    ));
  } finally {
    await prepared.controller.close();
  }
}
