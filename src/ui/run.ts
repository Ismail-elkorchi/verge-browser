import { createTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderElementFrame, renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { runTui } from "@ismail-elkorchi/terminal-ui/tui";

import type { BrowserSession } from "../app/session.js";
import type { BrowserStore } from "../app/storage.js";
import type { TerminalSize } from "@ismail-elkorchi/terminal-ui/host";
import type { BrowserServices } from "./services.js";
import { createBrowserApp, createBrowserInitialState } from "./app.js";
import { BrowserController } from "./browser-controller.js";
import { browserView } from "./view.js";

export interface BrowserTuiOptions {
  readonly store: BrowserStore;
  readonly services: BrowserServices;
  readonly createSession: () => BrowserSession;
  readonly searchUrlTemplate?: string;
  readonly downloadDirectory?: string;
  readonly downloadMaxBytes?: number;
  readonly restoreWorkspace?: boolean;
}

export async function prepareBrowserTui(initialTarget: string, options: BrowserTuiOptions) {
  const controller = new BrowserController(options);
  const workspace = options.restoreWorkspace === true ? controller.workspace() : null;
  const storedDocuments = workspace?.documents ?? [];
  const documents = storedDocuments.length === 0
    ? [await controller.openInitial(initialTarget)]
    : await Promise.all(storedDocuments.map((document) =>
      controller.openInitial(document.url, document.scrollAnchor)
    ));
  const state = createBrowserInitialState(
    documents,
    workspace?.activeDocumentIndex ?? 0,
    controller,
    workspace?.sidePanel ?? null
  );
  return {
    controller,
    state,
    app: createBrowserApp(state, controller)
  };
}

export async function runBrowserTui(initialTarget: string, options: BrowserTuiOptions): Promise<void> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  const exit = await runTui(
    prepared.app,
    createTerminalHost({ runtime: "node" }),
    {
      initialFocus: prepared.state.documents[prepared.state.activeDocumentIndex]?.snapshot.finalUrl === "about:newtab"
        ? { kind: "element", elementId: "browser-omnibox" }
        : {
          kind: "element",
          elementId: `browser-${prepared.state.documents[prepared.state.activeDocumentIndex]?.id ?? ""}`
        }
    }
  );
  if (exit.status === "error") {
    throw new Error("The terminal UI stopped because of a runtime error.");
  }
}

export async function renderBrowserOnce(
  initialTarget: string,
  options: BrowserTuiOptions,
  terminalSize: TerminalSize
): Promise<string> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  return renderFramePlain(renderElementFrame(
    browserView(prepared.state, { terminalSize }),
    terminalSize
  ));
}
