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
}

export async function prepareBrowserTui(initialTarget: string, options: BrowserTuiOptions) {
  const controller = new BrowserController(options);
  const document = await controller.openInitial(initialTarget);
  const state = createBrowserInitialState(document);
  return {
    controller,
    state,
    app: createBrowserApp(document, controller)
  };
}

export async function runBrowserTui(initialTarget: string, options: BrowserTuiOptions): Promise<void> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  const exit = await runTui(
    prepared.app,
    createTerminalHost({ runtime: "node" }),
    { initialFocus: { kind: "element", elementId: `browser-${prepared.state.documents[0]?.id ?? ""}` } }
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
