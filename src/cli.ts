#!/usr/bin/env node
import { BrowserSession } from "./app/session.js";
import { BrowserStore } from "./app/storage.js";
import { createNodeBrowserServices } from "./runtime/node-browser-services.js";
import { renderBrowserOnce, runBrowserTui } from "./ui/run.js";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";

interface CliFlags {
  readonly initialTarget: string | null;
  readonly runOnce: boolean;
}

function parseCliFlags(argv: readonly string[]): CliFlags {
  let initialTarget: string | null = null;
  let runOnce = false;

  for (const token of argv) {
    if (token === "--once") {
      runOnce = true;
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
    runOnce
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
    createSession: (httpSession: HttpSessionAdapter) => new BrowserSession({ httpSession }),
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

  await runBrowserTui(initialTarget, browserOptions);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
