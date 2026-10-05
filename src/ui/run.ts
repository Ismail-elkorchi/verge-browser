import { renderElementFrame, renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { defaultSessionProtocolPolicy, runTui } from "@ismail-elkorchi/terminal-ui/tui";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

import type { PageAcquisition } from "../app/page-acquisition.js";
import type { BrowserStore } from "../app/storage.js";
import type { RenderInstrumentation } from "../presentation/renderer/index.js";
import type { TerminalHost, TerminalSize } from "@ismail-elkorchi/terminal-ui/host";
import type { RenderWorkerClient } from "./render-worker/client.js";
import type { BrowserServices } from "./services.js";
import { createBrowserApp, createBrowserInitialState } from "./app.js";
import { BrowserController } from "./browser-controller.js";
import { browserRenderPreferences, browserPageSize, documentScrollRow } from "./document-layout.js";
import { browserView } from "./view.js";
import { createBrowserTextPresentation } from "./text-presentation.js";

export interface BrowserTuiOptions {
  readonly host?: TerminalHost;
  readonly store: BrowserStore;
  readonly services: BrowserServices;
  readonly createAcquisition: (httpSession: HttpSessionAdapter) => PageAcquisition;
  readonly searchUrlTemplate?: string;
  readonly downloadDirectory?: string;
  readonly downloadMaxBytes?: number;
  readonly restoreWorkspace?: boolean;
  readonly instrumentation?: RenderInstrumentation;
  readonly renderWorkerFactory?: () => RenderWorkerClient;
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
      textPresentation: createBrowserTextPresentation(),
      app: createBrowserApp(state, controller, options.instrumentation)
    };
  } catch (error) {
    return closeAfterFailure(controller, error);
  }
}

export async function runBrowserTui(initialTarget: string, options: BrowserTuiOptions): Promise<void> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  try {
    const activeTab = prepared.state.documents[prepared.state.activeDocumentIndex];
    await runTui(prepared.app, {
      ...(options.host === undefined ? {} : { host: options.host }),
      textPresentation: prepared.textPresentation,
      graphics: "auto",
      sessionPolicy: { ...defaultSessionProtocolPolicy, cellPresentation: "required" },
      initialFocus: activeTab !== undefined
        && (activeTab.kind === "ready" ? activeTab.snapshot.finalUrl : activeTab.requestedUrl) === "about:newtab"
        ? { kind: "element", elementId: "browser-omnibox" }
        : {
          kind: "element",
          elementId: `browser-${prepared.state.documents[prepared.state.activeDocumentIndex]?.id ?? ""}`
        }
    });
  } catch (error) {
    return closeAfterFailure(prepared.controller, error);
  }
  await prepared.controller.close();
}

export async function renderBrowserOnce(
  initialTarget: string,
  options: BrowserTuiOptions,
  terminalSize: TerminalSize
): Promise<string> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  let output: string;
  try {
    const selectedTab = prepared.state.documents[prepared.state.activeDocumentIndex] ?? prepared.state.documents[0];
    if (selectedTab === undefined) throw new Error("One-shot rendering requires an open document.");
    prepared.controller.configureRestoration(selectedTab);
    const selected = selectedTab.kind === "ready"
      ? selectedTab
      : await prepared.controller.restorePlaceholder(selectedTab);
    const pageSize = browserPageSize(prepared.state, terminalSize);
    const viewportRevision = selected.rendering.requestedViewportRevision + 1;
    const payload = await prepared.controller.renderViewport(selected, viewportRevision, {
      columns: pageSize.columns,
      rows: pageSize.rows,
      scrollRow: documentScrollRow(selected),
      scrollColumn: selected.scrollColumn ?? 0,
      scrollOffsets: selected.scrollOffsets,
      ...(selected.rendering.pendingReveal === null ? {} : { reveal: selected.rendering.pendingReveal }),
      overscanBefore: Math.min(6, pageSize.rows),
      overscanAfter: Math.min(12, pageSize.rows),
      preferences: browserRenderPreferences(),
      searchQuery: selected.search?.query ?? null,
    });
    const cellIncomplete = payload.cellBuffer.outcome.status === "rejected"
      ? [`cell-buffer.${payload.cellBuffer.outcome.reason}`]
      : payload.cellBuffer.outcome.status === "truncated"
        ? payload.cellBuffer.outcome.truncations.map((entry) =>
          `terminal.${entry.budget}=${String(entry.limit)}`
        )
        : [];
    const incomplete = [...new Set([...payload.summary.incomplete, ...cellIncomplete])];
    if (incomplete.length > 0) {
      throw new Error(`One-shot rendering was incomplete (${incomplete.join(", ")}).`);
    }
    const renderedDocument = {
      ...selected,
      scrollColumn: payload.scrollColumn ?? 0,
      scrollOffsets: payload.scrollOffsets,
      rendering: {
        ...selected.rendering,
        status: "ready" as const,
        requestedViewportRevision: viewportRevision,
        committedViewportRevision: viewportRevision,
        pendingReveal: null,
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
    output = renderFramePlain(renderElementFrame(
      browserView(renderedState, { terminalSize }),
      terminalSize,
      { textPresentation: prepared.textPresentation }
    ));
  } catch (error) {
    return closeAfterFailure(prepared.controller, error);
  }
  await prepared.controller.close();
  return output;
}

async function closeAfterFailure(controller: BrowserController, error: unknown): Promise<never> {
  try {
    await controller.close();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Browser operation and cleanup both failed.", { cause: error });
  }
  throw error;
}
