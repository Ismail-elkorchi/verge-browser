import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

async function writeCliHook(path, sources) {
  const cliUrl = pathToFileURL(resolve("dist/cli.js")).href;
  const modules = Object.fromEntries(Object.entries(sources).map(([specifier, source]) =>
    [specifier, `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`]));
  await writeFile(path, `import { registerHooks } from "node:module";
const modules = ${JSON.stringify(modules)};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === ${JSON.stringify(cliUrl)} && Object.hasOwn(modules, specifier))
    return { url: modules[specifier], shortCircuit: true };
  return next(specifier, context);
} });`, "utf8");
}

async function createFixture() {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "verge-browser-smoke-"));
  await writeFile(join(fixtureDirectory, "index.html"), `
    <html>
      <head><title>Index</title></head>
      <body>
        <h1>Index</h1>
        <p><a href="./next.html">Next page</a></p>
      </body>
    </html>
  `, "utf8");
  await writeFile(join(fixtureDirectory, "next.html"), `
    <html>
      <head><title>Next</title></head>
      <body>
        <h1>Next</h1>
        <p>Second page</p>
      </body>
    </html>
  `, "utf8");
  return fixtureDirectory;
}

async function runSmokeCheck() {
  const fixtureDirectory = await createFixture();
  const target = pathToFileURL(join(fixtureDirectory, "index.html")).href;

  try {
    const once = spawnSync(process.execPath, ["dist/cli.js", "--once", target], {
      encoding: "utf8",
      timeout: 8_000,
      env: { ...process.env, XDG_STATE_HOME: join(fixtureDirectory, "state") }
    });
    if (once.status !== 0) {
      throw new Error(`CLI --once failed with exit code ${String(once.status)}\n${once.stderr}`);
    }
    if (!once.stdout.includes("Index") || !once.stdout.includes("Next page")) {
      throw new Error("CLI --once did not render the initial document.");
    }
    const outputLines = once.stdout.split("\n");
    const addressRow = outputLines.findIndex((line) => line.includes("⌕ "));
    const documentHeadingRow = outputLines.findIndex((line, index) => index > 0 && line.trim() === "Index");
    if (addressRow < 0 || documentHeadingRow < 0 || addressRow > documentHeadingRow) {
      throw new Error("CLI --once did not render browser chrome before the document.");
    }
    if (once.stdout.includes("\u001b")) {
      throw new Error("CLI --once emitted terminal control sequences.");
    }

  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

async function verifyCliHostOwnership() {
  const directory = await mkdtemp(join(tmpdir(), "verge-cli-ownership-"));
  const hook = join(directory, "host-hook.mjs");
  const events = join(directory, "events.txt");
  const hostModule = `import { appendFileSync } from "node:fs";
import { createNodeTerminalHost as createHost } from ${JSON.stringify(import.meta.resolve("@ismail-elkorchi/terminal-ui/host"))};
export function createNodeTerminalHost(options) {
  if (options.capabilities.cellPresentation.policy !== "auto") throw new Error("missing automatic policy");
  appendFileSync(process.env.CLI_EVENTS, "create\\n");
  const host = createHost(options);
  const dispose = host.dispose.bind(host);
  host.dispose = async (context) => {
    appendFileSync(process.env.CLI_EVENTS, "dispose\\n");
    await dispose(context);
    if (process.env.CLI_DISPOSE_FAIL === "1") throw new Error("injected disposal failure");
  };
  return host;
}`;
  const runModule = `import { appendFileSync } from "node:fs";
export async function runBrowserTui(target, options) {
  if (!options.host) throw new Error("missing owned host");
  appendFileSync(process.env.CLI_EVENTS, "run\\n");
  if (process.env.CLI_FAIL === "1") throw new Error("injected startup failure");
}
export async function renderBrowserOnce() { throw new Error("unexpected one-shot rendering"); }`;
  await writeCliHook(hook, {
    "@ismail-elkorchi/terminal-ui/host": hostModule,
    "./ui/run.js": runModule
  });
  try {
    for (const [fail, disposeFail] of [[false, false], [true, false], [false, true], [true, true]]) {
      await writeFile(events, "", "utf8");
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(hook).href, "dist/cli.js", "about:newtab"
      ], { encoding: "utf8", timeout: 8_000, env: {
        ...process.env, CLI_EVENTS: events, CLI_FAIL: fail ? "1" : "0",
        CLI_DISPOSE_FAIL: disposeFail ? "1" : "0",
        XDG_STATE_HOME: join(directory, "state")
      } });
      if (result.status !== (fail || disposeFail ? 1 : 0)
        || await readFile(events, "utf8") !== "create\nrun\ndispose\n"
        || fail && !result.stderr.includes("injected startup failure")
        || disposeFail && !result.stderr.includes("injected disposal failure")) {
        throw new Error(`CLI host lifecycle failed (run=${fail}, dispose=${disposeFail}): ${result.stderr}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyCliAutomaticPresentation() {
  const directory = await mkdtemp(join(tmpdir(), "verge-cli-presentation-"));
  const hook = join(directory, "host-hook.mjs");
  const realHostUrl = import.meta.resolve("@ismail-elkorchi/terminal-ui/host");
  const hostModule = `import { createMemoryTerminalHost } from ${JSON.stringify(realHostUrl)};
import { appendFileSync } from "node:fs";
export function createNodeTerminalHost(options) {
  const scenario = process.env.CLI_SCENARIO;
  const host = createMemoryTerminalHost({ ...options, env: scenario === "kitty" ? { TERM: "xterm-kitty", KITTY_WINDOW_ID: "1" } : { TERM: "xterm-256color" } });
  let reset = false;
  let restored = false;
  for (const method of ["write", "writeRecovery"]) {
    const originalWrite = host.stdout[method].bind(host.stdout);
    host.stdout[method] = async (chunk, context) => {
      const result = await originalWrite(chunk, context);
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      if (text.includes("\\u001b[8l")) reset = true;
      if (text.includes("\\u001b[8h")) restored = true;
      const queries = [...text.matchAll(/\\[(\\??)(\\d+)\\$p/gu)];
      for (const [, prefix, mode] of queries) {
        if (prefix === "" && mode === "8" && scenario === "verification-missing" && reset && !restored) continue;
        const state = prefix !== "" || mode !== "8" ? 2 : scenario === "fixed" ? 3
          : scenario === "normal" || scenario === "kitty" || scenario === "raw-input" ? 2
          : reset && !restored && scenario !== "verification-mismatch" ? 2 : 1;
        host.input("\\u001b[" + prefix + mode + ";" + state + "$y");
      }
      if (queries.length > 0) host.input("\\u001b[?1;2c");
      return result;
    };
  }
  if (scenario === "raw-input") {
    const setRawMode = host.stdin.setRawMode.bind(host.stdin);
    host.stdin.setRawMode = (enabled) => {
      if (enabled) throw new Error("injected raw-input failure");
      return setRawMode(enabled);
    };
  }
  const timer = setInterval(() => {
    host.clock.advance(100);
    if (host.frames().length > 0) host.input("\\u0003");
  }, 5);
  const originalDispose = host.dispose.bind(host);
  host.dispose = async () => {
    appendFileSync(process.env.CLI_EVENTS, JSON.stringify({ frames: host.frames().length, raw: host.stdin.isRawModeEnabled(), reset, restored }) + "\\n");
    try { await originalDispose(); } finally { clearInterval(timer); }
    if (process.env.CLI_DISPOSE_FAIL === "1") throw new Error("injected host cleanup failure");
  };
  return host;
}`;
  await writeCliHook(hook, { "@ismail-elkorchi/terminal-ui/host": hostModule });
  try {
    for (const scenario of ["normal", "reset", "kitty", "fixed", "raw-input", "verification-missing", "verification-mismatch"]) {
      for (const cleanupFailure of [false, true]) {
        const events = join(directory, `${scenario}-${cleanupFailure}.txt`);
        const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, "dist/cli.js",
          ...(scenario === "normal" ? [] : ["about:newtab"])], {
          encoding: "utf8", timeout: 15_000, env: {
            ...process.env, CLI_SCENARIO: scenario, CLI_EVENTS: events,
            CLI_DISPOSE_FAIL: cleanupFailure ? "1" : "0", XDG_STATE_HOME: join(directory, "state")
          }
        });
        const accepted = scenario === "normal" || scenario === "reset";
        if (result.error || result.status !== (accepted && !cleanupFailure ? 0 : 1)) {
          throw new Error(`Actual CLI automatic startup (${scenario}, cleanup=${cleanupFailure}): ${result.error ?? ""} ${result.stderr}`);
        }
        const event = JSON.parse(await readFile(events, "utf8"));
        if (accepted) {
          const state = JSON.parse(await readFile(join(directory, "state", "verge-browser", "state.json"), "utf8"));
          if (state.terminalSettings.length !== 0) throw new Error("Successful startup must not persist terminal assertions.");
        }
        if ((event.frames > 0) !== accepted || event.raw !== false
          || scenario === "reset" && (!event.reset || !event.restored)
          || cleanupFailure && !result.stderr.includes("injected host cleanup failure")
          || scenario === "kitty" && !result.stderr.includes("--remember-terminal-setting=kitty-force-ltr")) {
          throw new Error(`Actual CLI automatic startup ownership failed (${scenario}): ${JSON.stringify(event)} ${result.stderr}`);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}


try {
  await runSmokeCheck();
  await verifyCliHostOwnership();
  await verifyCliAutomaticPresentation();
  const invalidOption = spawnSync(process.execPath, ["dist/cli.js", "--unknown-option"], {
    encoding: "utf8"
  });
  if (invalidOption.status !== 1 || !invalidOption.stderr.includes("Unknown option: --unknown-option")) {
    throw new Error("CLI did not reject an unknown option");
  }
  for (const value of ["implicit", "explicit", "existing", "mode-8-reset", "unknown"]) {
    const invalidPresentation = spawnSync(process.execPath, [
      "dist/cli.js", `--terminal-cell-presentation=${value}`
    ], { encoding: "utf8" });
    if (invalidPresentation.status !== 1 || !invalidPresentation.stderr.includes("Unknown option:")) {
      throw new Error("CLI must reject unsupported terminal-state declarations.");
    }
  }
  process.stdout.write("cli smoke ok\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cli-smoke failed: ${message}\n`);
  process.exit(1);
}
