#!/usr/bin/env node
import { PageAcquisition } from "./app/page-acquisition.js";
import { BrowserStore } from "./app/storage.js";
import { createNodeBrowserServices } from "./runtime/node-browser-services.js";
import { renderBrowserOnce, runBrowserTui } from "./ui/run.js";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";
import { createNodeTerminalHost } from "@ismail-elkorchi/terminal-ui/host";

interface CliFlags {
  readonly initialTarget: string | null;
  readonly runOnce: boolean;
  readonly explicitCellPresentation: boolean;
}

function parseCliFlags(argv: readonly string[]): CliFlags {
  let initialTarget: string | null = null;
  let runOnce = false;
  let explicitCellPresentation = false;

  for (const token of argv) {
    if (token === "--once") {
      runOnce = true;
      continue;
    }
    if (token === "--terminal-cell-presentation=explicit") {
      explicitCellPresentation = true;
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
    explicitCellPresentation
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

  await runBrowserTui(initialTarget, {
    ...browserOptions,
    ...(cliFlags.explicitCellPresentation ? {
      host: createNodeTerminalHost({ initialState: { cellPresentation: "explicit" } })
    } : {})
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
