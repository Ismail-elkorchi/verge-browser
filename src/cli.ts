#!/usr/bin/env node
import { PageAcquisition } from "./app/page-acquisition.js";
import { BrowserStore, type StoredTerminalSetting } from "./app/storage.js";
import { createNodeBrowserServices } from "./runtime/node-browser-services.js";
import { renderBrowserOnce, runBrowserTui } from "./ui/run.js";
import type { HttpSessionAdapter } from "@ismail-elkorchi/http-client";
import { createNodeTerminalHost, type TerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { defaultTuiLifecyclePolicy, TuiRunError } from "@ismail-elkorchi/terminal-ui/tui";

interface CliFlags {
  readonly initialTarget: string | null;
  readonly runOnce: boolean;
  readonly rememberTerminalSetting: StoredTerminalSetting["condition"] | null;
  readonly forgetTerminalSetting: StoredTerminalSetting["condition"] | null;
}

function parseCliFlags(argv: readonly string[]): CliFlags {
  let initialTarget: string | null = null;
  let runOnce = false;
  let rememberTerminalSetting: CliFlags["rememberTerminalSetting"] = null;
  let forgetTerminalSetting: CliFlags["forgetTerminalSetting"] = null;

  for (const token of argv) {
    if (token === "--once") {
      runOnce = true;
      continue;
    }
    if (token === "--remember-terminal-setting=kitty-force-ltr" || token === "--remember-terminal-setting=konsole-bidi-disabled") {
      if (rememberTerminalSetting !== null) throw new Error("Remember one terminal setting at a time.");
      rememberTerminalSetting = token === "--remember-terminal-setting=kitty-force-ltr" ? "kitty-force-ltr" : "konsole-bidi-disabled";
      continue;
    }
    if (token === "--forget-terminal-setting=kitty-force-ltr" || token === "--forget-terminal-setting=konsole-bidi-disabled") {
      if (forgetTerminalSetting !== null) throw new Error("Forget one terminal setting at a time.");
      forgetTerminalSetting = token === "--forget-terminal-setting=kitty-force-ltr" ? "kitty-force-ltr" : "konsole-bidi-disabled";
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (initialTarget === null) {
      initialTarget = token;
    }
  }

  if (rememberTerminalSetting !== null && forgetTerminalSetting !== null) {
    throw new Error("Remember and forget terminal settings are separate commands.");
  }
  if ((rememberTerminalSetting !== null || forgetTerminalSetting !== null) && (initialTarget !== null || runOnce)) {
    throw new Error("Terminal setting commands exit without browsing; do not combine them with a target or --once.");
  }
  return { initialTarget, runOnce, rememberTerminalSetting, forgetTerminalSetting };
}

async function rememberTerminalSetting(host: TerminalHost, store: BrowserStore, flags: CliFlags): Promise<string> {
  // The same host owns classification, context and normal startup admission. No CLI probing.
  const capabilities = await host.getCapabilities();
  const facts = capabilities.cellPresentation.facts;
  const context = facts.find((fact) => fact.name === "cellPresentation.context")?.value;
  if (!capabilities.isTty || typeof context !== "string" || context.length === 0) {
    throw new Error("This terminal and transport cannot be identified safely. Use a directly attached supported terminal before remembering a setting.");
  }
  const condition = flags.rememberTerminalSetting;
  const conditions = facts.find((fact) => fact.name === "cellPresentation.conditions")?.value;
  if (condition === null || !Array.isArray(conditions) || !conditions.includes(condition)) {
    throw new Error("That setting does not apply to the current terminal and transport. Run the command in the terminal you configured.");
  }
  await store.rememberTerminalSetting({ context, condition });
  return `Remembered ${condition} for all direct sessions sharing this recorded terminal identity and version, including other windows and profiles. `
    + "This replaces that condition's previous saved context. "
    + "The terminal must already be configured consistently across that scope; an individual profile or temporary launch override is not sufficient. "
    + "This is a user-maintained assumption, not a verified setting; observed contradictions still block startup.";
}

async function disposeTerminalHost(host: TerminalHost, failures: unknown[]): Promise<void> {
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
}

async function main(): Promise<void> {
  const cliFlags = parseCliFlags(process.argv.slice(2));
  if (cliFlags.forgetTerminalSetting !== null) {
    await BrowserStore.forgetTerminalSetting(cliFlags.forgetTerminalSetting);
    process.stdout.write(`Forgot the saved ${cliFlags.forgetTerminalSetting} assertion, regardless of its recorded terminal context.\n`);
    return;
  }
  const store = await BrowserStore.open();
  const searchUrlTemplate = process.env["VERGE_SEARCH_URL_TEMPLATE"];
  const downloadDirectory = process.env["VERGE_DOWNLOAD_DIR"];
  const browserOptions = () => ({
    store,
    services: createNodeBrowserServices(),
    createAcquisition: (httpSession: HttpSessionAdapter) => new PageAcquisition({ httpSession }),
    ...(searchUrlTemplate === undefined ? {} : { searchUrlTemplate }),
    ...(downloadDirectory === undefined ? {} : { downloadDirectory }),
    restoreWorkspace: cliFlags.initialTarget === null && !cliFlags.runOnce
  });
  const initialTarget = cliFlags.initialTarget ?? "about:newtab";
  if (cliFlags.runOnce) {
    const output = await renderBrowserOnce(initialTarget, browserOptions(), {
      columns: process.stdout.columns || 100,
      rows: process.stdout.rows || 24
    });
    process.stdout.write(`${output}\n`);
    return;
  }
  const host = createNodeTerminalHost({
    capabilities: { cellPresentation: { policy: "auto", exceptions: store.terminalSettings() } }
  });
  const failures: unknown[] = [];
  let result: string | undefined;
  try {
    if (cliFlags.rememberTerminalSetting !== null) {
      result = await rememberTerminalSetting(host, store, cliFlags);
    } else {
      await runBrowserTui(initialTarget, { ...browserOptions(), host });
    }
  } catch (error) {
    failures.push(error);
  }
  await disposeTerminalHost(host, failures);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Browser operation and terminal cleanup both failed.", { cause: failures[0] });
  }
  if (result !== undefined) process.stdout.write(`${result}\n`);
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
    const diagnostic = current.primaryDiagnostic;
    if (diagnostic === undefined || !diagnostic.code.startsWith("HOST_CELL_PRESENTATION_")) return undefined;
    const hint = diagnostic.hint;
    const conditions = diagnostic.data?.["conditions"];
    const commands = diagnostic.data?.["contextAvailable"] === true && Array.isArray(conditions) ? conditions.flatMap((condition: unknown) =>
      condition === "kitty-force-ltr" || condition === "konsole-bidi-disabled"
        ? [`Only after configuring all direct sessions sharing this terminal identity and reported version, including other windows and profiles, run verge --remember-terminal-setting=${condition} once. `
          + "An individual profile or temporary launch override is not sufficient; the saved assumption is shared across that scope."] : []) : [];
    return (hint === undefined ? "" : `${hint} `) + (commands.length === 0 ? "" : `${commands.join(" ")} `)
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
