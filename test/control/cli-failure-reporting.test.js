import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const cliUrl = new URL("../../dist/cli.js", import.meta.url);
const hostUrl = import.meta.resolve("@ismail-elkorchi/terminal-ui/host");
const storeUrl = new URL("../../dist/app/storage.js", import.meta.url).href;
const primaryMessage = "Application-ordered physical cells are unqualified";
const cleanupMessages = {
  services: "injected browser services cleanup failure",
  flush: "injected browser store flush failure",
  host: "injected terminal host cleanup failure"
};

async function reportingHook(directory) {
  const sources = {
    "@ismail-elkorchi/terminal-ui/host": `import { createMemoryTerminalHost } from ${JSON.stringify(hostUrl)};
import { appendFileSync } from "node:fs";
export function createNodeTerminalHost(options) {
  const host = createMemoryTerminalHost(options);
  const write = host.stdout.write.bind(host.stdout);
  host.stdout.write = async (chunk, context) => {
    await write(chunk, context);
    const queries = [...String(chunk).matchAll(/\\[(\\??)(\\d+)\\$p/gu)];
    if (queries.length > 0) host.input(queries.map(([, prefix, mode]) =>
      "\\u001b[" + prefix + mode + ";" + (prefix === "" && mode === "8" ? "2" : "0") + "$y").join("") + "\\u001b[?1;2c");
  };
  const dispose = host.dispose.bind(host);
  host.dispose = async () => {
    appendFileSync(process.env.CLI_EVENTS, "frames=" + host.frames().length + "\\n");
    await dispose();
    if (process.env.CLI_HOST_FAILURE === "1") throw new Error(${JSON.stringify(cleanupMessages.host)});
  };
  return host;
}`,
    "./runtime/node-browser-services.js": `export function createNodeBrowserServices() {
  return {
    async writeTextFile() {}, async downloadFile() {}, async openExternal() {}, async openPath() {},
    async close() {
      if (process.env.CLI_SERVICES_FAILURE === "1") throw new Error(${JSON.stringify(cleanupMessages.services)});
    }
  };
}`,
    "./app/storage.js": `import { BrowserStore as RealBrowserStore } from ${JSON.stringify(storeUrl)};
export const BrowserStore = {
  async open(...args) {
    const store = await RealBrowserStore.open(...args);
    const flush = store.flush.bind(store);
    store.flush = async () => {
      await flush();
      if (process.env.CLI_FLUSH_FAILURE === "1") throw new Error(${JSON.stringify(cleanupMessages.flush)});
    };
    return store;
  }
};`
  };
  const modules = Object.fromEntries(Object.entries(sources).map(([specifier, source]) =>
    [specifier, `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`]));
  const hook = join(directory, "reporting-hook.mjs");
  await writeFile(hook, `import { registerHooks } from "node:module";
const modules = ${JSON.stringify(modules)};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === ${JSON.stringify(cliUrl.href)} && Object.hasOwn(modules, specifier))
    return { url: modules[specifier], shortCircuit: true };
  return next(specifier, context);
} });`, "utf8");
  return hook;
}

for (const failures of [[], ["services"], ["flush"], ["services", "flush"], ["services", "flush", "host"]]) {
  test(`actual CLI reports primary admission failure and ${failures.join("+") || "no"} cleanup failures`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "verge-cli-failure-reporting-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const hook = await reportingHook(directory);
    const events = join(directory, "events.txt");
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href,
      fileURLToPath(cliUrl), "about:newtab"], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(directory, "state"),
        CLI_EVENTS: events,
        CLI_SERVICES_FAILURE: failures.includes("services") ? "1" : "0",
        CLI_FLUSH_FAILURE: failures.includes("flush") ? "1" : "0",
        CLI_HOST_FAILURE: failures.includes("host") ? "1" : "0"
      }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.startsWith(`Fatal error: ${primaryMessage}`), result.stderr);
    assert.equal(await readFile(events, "utf8"), "frames=0\n");
    assert.equal(result.stderr.split(primaryMessage).length - 1, 1);
    assert.ok(result.stderr.includes("After verifying your terminal configuration and transport"), result.stderr);
    let previous = result.stderr.indexOf(primaryMessage);
    for (const [name, message] of Object.entries(cleanupMessages)) {
      assert.equal(result.stderr.split(message).length - 1, failures.includes(name) ? 1 : 0, result.stderr);
      if (failures.includes(name)) {
        const position = result.stderr.indexOf(message);
        assert.ok(position > previous, result.stderr);
        previous = position;
      }
    }
  });
}

async function stalledOutputHook(directory) {
  const source = `import { createNodeTerminalHost as createHost } from ${JSON.stringify(hostUrl)};
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { setInterval, clearInterval } from "node:timers";
export function createNodeTerminalHost(options) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, pause() {}, resume() {}, unref() {},
    setRawMode(enabled) { this.isRaw = enabled; }
  });
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write() { return true; }
  });
  const host = createHost({ ...options, stdin: input, stdout: output, env: { TERM: "dumb" } });
  const keepalive = process.env.CLI_KEEP_ALIVE === "1" ? setInterval(() => {}, 1000) : undefined;
  const dispose = host.dispose.bind(host);
  host.dispose = async (context) => {
    appendFileSync(process.env.CLI_EVENTS, "dispose\\n");
    context?.signal?.addEventListener("abort", () => {
      appendFileSync(process.env.CLI_EVENTS,
        "aborted=" + context.signal.aborted + " raw=" + input.isRaw + "\\n");
    }, { once: true });
    try { await dispose(context); }
    finally { clearInterval(keepalive); }
  };
  return host;
}`;
  const hook = join(directory, "stalled-output-hook.mjs");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  await writeFile(hook, `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === ${JSON.stringify(cliUrl.href)} && specifier === "@ismail-elkorchi/terminal-ui/host")
    return { url: ${JSON.stringify(moduleUrl)}, shortCircuit: true };
  return next(specifier, context);
} });`, "utf8");
  return hook;
}

for (const keepAlive of [false, true]) {
  test(`actual CLI bounds stalled Node output disposal with ${keepAlive ? "an active handle" : "only pending promises"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "verge-cli-stalled-disposal-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const hook = await stalledOutputHook(directory);
    const events = join(directory, "events.txt");
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href,
      fileURLToPath(cliUrl), "about:newtab"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(directory, "state"),
        CLI_EVENTS: events,
        CLI_KEEP_ALIVE: keepAlive ? "1" : "0"
      }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.startsWith("Fatal error: Terminal protocol is unavailable: alternateScreen."), result.stderr);
    assert.ok(result.stderr.includes("Cleanup: TUI finalization timed out: flush."), result.stderr);
    assert.ok(result.stderr.includes("Terminal host cleanup timed out."), result.stderr);
    assert.equal(result.stderr.split("Terminal host cleanup timed out.").length - 1, 1);
    assert.ok(!result.stderr.includes("After verifying your terminal configuration and transport"), result.stderr);
    assert.equal(await readFile(events, "utf8"), "dispose\naborted=true raw=false\n");
  });
}
