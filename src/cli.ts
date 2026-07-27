#!/usr/bin/env node
import { BrowserSession } from "./app/session.js";
import { BrowserStore } from "./app/storage.js";
import { createNodeHost } from "./runtime/node-host.js";
import { createNodeShellServices } from "./runtime/node-shell-services.js";
import { createNodeTerminalAdapter } from "./runtime/node-terminal-adapter.js";
import { BrowserShell } from "./ui/shell.js";

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
  const adapter = createNodeTerminalAdapter();
  const runtimeHost = createNodeHost();
  const services = createNodeShellServices();
  const store = await BrowserStore.open();

  const shell = new BrowserShell({
    adapter,
    store,
    services,
    createSession: () => new BrowserSession({
      widthProvider: () => adapter.getSize().columns,
      localFileReader: (path) => runtimeHost.readFileText(path)
    })
  });

  const initialTarget = cliFlags.initialTarget ?? store.latestHistoryUrl() ?? "about:help";

  if (cliFlags.runOnce) {
    await shell.runOnce(initialTarget);
    const state = shell.getState();
    const activeDocument = state.documents[state.activeDocumentIndex];
    if (!activeDocument?.snapshot && state.status?.tone === "error") {
      throw new Error(state.status.text);
    }
    adapter.dispose();
    return;
  }

  await shell.run(initialTarget);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
