#!/usr/bin/env node
import { BrowserSession } from "./app/session.js";
import { BrowserStore } from "./app/storage.js";
import { createNodeHost } from "./runtime/node-host.js";
import { createNodeBrowserServices } from "./runtime/node-browser-services.js";
import { renderBrowserOnce, runBrowserTui } from "./ui/run.js";

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
  const runtimeHost = createNodeHost();
  const services = createNodeBrowserServices();
  const store = await BrowserStore.open();
  const browserOptions = {
    store,
    services,
    createSession: () => new BrowserSession({
      localFileReader: (path) => runtimeHost.readFileText(path)
    })
  };

  const initialTarget = cliFlags.initialTarget ?? store.latestHistoryUrl() ?? "about:help";

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
