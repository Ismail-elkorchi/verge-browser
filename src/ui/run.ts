import { renderElementFrame, renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { runTui, TuiRunError } from "@ismail-elkorchi/terminal-ui/tui";
import type { DiagnosticOccurrence, TerminalDiagnosticValue } from "@ismail-elkorchi/terminal-ui";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

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
  readonly createSession: (httpSession: HttpSessionAdapter) => BrowserSession;
  readonly searchUrlTemplate?: string;
  readonly downloadDirectory?: string;
  readonly downloadMaxBytes?: number;
  readonly restoreWorkspace?: boolean;
}

export async function prepareBrowserTui(initialTarget: string, options: BrowserTuiOptions) {
  const controller = new BrowserController(options);
  try {
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
  } catch (error) {
    await controller.close();
    throw error;
  }
}

export async function runBrowserTui(initialTarget: string, options: BrowserTuiOptions): Promise<void> {
  const prepared = await prepareBrowserTui(initialTarget, options);
  try {
    await runTui(prepared.app, {
      initialFocus: prepared.state.documents[prepared.state.activeDocumentIndex]?.snapshot.finalUrl === "about:newtab"
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
    return renderFramePlain(renderElementFrame(
      browserView(prepared.state, { terminalSize }),
      terminalSize
    ));
  } finally {
    await prepared.controller.close();
  }
}
