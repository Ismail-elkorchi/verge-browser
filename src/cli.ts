#!/usr/bin/env node
import { PageAcquisition } from "./app/page-acquisition.js";
import { BrowserStore } from "./app/storage.js";
import { createNodeBrowserServices } from "./runtime/node-browser-services.js";
import { renderBrowserOnce, runBrowserTui } from "./ui/run.js";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";
import { createNodeTerminalHost, type TerminalCellPresentationQualification } from "@ismail-elkorchi/terminal-ui/host";
import { defaultTuiLifecyclePolicy, TuiRunError } from "@ismail-elkorchi/terminal-ui/tui";

interface CliFlags {
  readonly initialTarget: string | null;
  readonly runOnce: boolean;
  readonly terminalPresentation: TerminalCellPresentationQualification["qualification"] | null;
}

function parseCliFlags(argv: readonly string[]): CliFlags {
  let initialTarget: string | null = null;
  let runOnce = false;
  let terminalPresentation: CliFlags["terminalPresentation"] = null;

  for (const token of argv) {
    if (token === "--once") {
      runOnce = true;
      continue;
    }
    if (token === "--terminal-cell-presentation=existing") {
      terminalPresentation = "existing";
      continue;
    }
    if (token === "--terminal-cell-presentation=mode-8-reset") {
      terminalPresentation = "mode-8-reset";
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (initialTarget === null) {
      initialTarget = token;
    }
  }

  return {
    initialTarget,
    runOnce,
    terminalPresentation
  };
}

async function main(): Promise<void> {
  const cliFlags = parseCliFlags(process.argv.slice(2));
  const services = createNodeBrowserServices();
  const store = await BrowserStore.open();
  const searchUrlTemplate = process.env["VERGE_SEARCH_URL_TEMPLATE"];
  const downloadDirectory = process.env["VERGE_DOWNLOAD_DIR"];
  const browserOptions = {
    store,
    services,
    createAcquisition: (httpSession: HttpSessionAdapter) => new PageAcquisition({ httpSession }),
    ...(searchUrlTemplate === undefined ? {} : { searchUrlTemplate }),
    ...(downloadDirectory === undefined ? {} : { downloadDirectory }),
    restoreWorkspace: cliFlags.initialTarget === null && !cliFlags.runOnce
  };

  const initialTarget = cliFlags.initialTarget ?? "about:newtab";

  if (cliFlags.runOnce) {
    const output = await renderBrowserOnce(initialTarget, browserOptions, {
      columns: process.stdout.columns || 100,
      rows: process.stdout.rows || 24
    });
    process.stdout.write(`${output}\n`);
    return;
  }

  const host = createNodeTerminalHost({
    ...(cliFlags.terminalPresentation === null ? {}
      : { cellPresentation: { qualification: cliFlags.terminalPresentation } })
  });
  const failures: unknown[] = [];
  try {
    await runBrowserTui(initialTarget, {
      ...browserOptions,
      host
    });
  } catch (error) {
    failures.push(error);
  }
  const disposalController = new AbortController();
  const timerController = new AbortController();
  try {
    await Promise.race([
      host.dispose({ signal: disposalController.signal }),
      // The host clock keeps Node alive until cleanup settles or its deadline fires.
      host.clock.sleep(defaultTuiLifecyclePolicy.hostDisposalTimeoutMs, timerController.signal).then((outcome) => {
        if (outcome === "aborted") return;
        const error = new Error("Terminal host cleanup timed out.");
        disposalController.abort(error);
        throw error;
      })
    ]);
  } catch (error) {
    disposalController.abort(error);
    failures.push(error);
  } finally {
    timerController.abort();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Browser operation and terminal cleanup both failed.", { cause: failures[0] });
  }
}

function failureMessage(error: unknown): string {
  const pending = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof AggregateError && current.errors.length > 0) {
      for (let index = current.errors.length - 1; index >= 0; index -= 1) pending.push(current.errors[index]);
    } else {
      messages.push(current instanceof Error ? current.message : String(current));
    }
  }
  return messages.length > 0 ? messages.join(" Cleanup: ")
    : error instanceof Error ? error.message : String(error);
}

function presentationGuidance(error: unknown): string | undefined {
  const seen = new Set<Error>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (!(current instanceof TuiRunError)) continue;
    if (current.primaryDiagnostic?.code !== "HOST_CELL_PRESENTATION_UNQUALIFIED") return undefined;
    return "Verge needs application-ordered left-to-right cells and matching input coordinates. "
      + "After verifying your terminal configuration and transport, use --terminal-cell-presentation=existing "
      + "if that guarantee already holds, or --terminal-cell-presentation=mode-8-reset if it holds after a verified mode-8 reset. "
      + "These declarations do not configure character direction. Kitty also needs force_ltr=yes. "
      + "See https://github.com/Ismail-elkorchi/verge-browser/blob/main/docs/reference/cli.md#terminal-presentation";
  }
  return undefined;
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${failureMessage(error)}`);
  const guidance = presentationGuidance(error);
  if (guidance !== undefined) console.error(guidance);
  process.exit(1);
});
