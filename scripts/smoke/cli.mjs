import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

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
      timeout: 8_000
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
    const declared = spawnSync(process.execPath, [
      "dist/cli.js", "--terminal-cell-presentation=explicit", "--once", target
    ], { encoding: "utf8", timeout: 8_000 });
    if (declared.status !== 0 || declared.stdout !== once.stdout) {
      throw new Error("Explicit terminal state must not change plain one-shot output.");
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

async function verifyCliHostOwnership() {
  const directory = await mkdtemp(join(tmpdir(), "verge-cli-ownership-"));
  const hook = join(directory, "host-hook.mjs");
  const events = join(directory, "events.txt");
  const cliUrl = pathToFileURL(resolve("dist/cli.js")).href;
  const hostModule = `import { appendFileSync } from "node:fs";
export function createNodeTerminalHost(options) {
  if (options.initialState.cellPresentation !== "explicit") throw new Error("invalid initial state");
  appendFileSync(process.env.CLI_EVENTS, "create\\n");
  return { async dispose() {
    appendFileSync(process.env.CLI_EVENTS, "dispose\\n");
    if (process.env.CLI_DISPOSE_FAIL === "1") throw new Error("injected disposal failure");
  } };
}`;
  const runModule = `import { appendFileSync } from "node:fs";
export async function runBrowserTui(target, options) {
  if (!options.host) throw new Error("missing owned host");
  appendFileSync(process.env.CLI_EVENTS, "run\\n");
  if (process.env.CLI_FAIL === "1") throw new Error("injected startup failure");
}
export async function renderBrowserOnce() { throw new Error("unexpected one-shot rendering"); }`;
  await writeFile(hook, `import { registerHooks } from "node:module";
const modules = ${JSON.stringify({
    "@ismail-elkorchi/terminal-ui/host": `data:text/javascript;base64,${Buffer.from(hostModule).toString("base64")}`,
    "./ui/run.js": `data:text/javascript;base64,${Buffer.from(runModule).toString("base64")}`
  })};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === ${JSON.stringify(cliUrl)} && Object.hasOwn(modules, specifier)) {
    return { url: modules[specifier], shortCircuit: true };
  }
  return next(specifier, context);
} });`, "utf8");
  try {
    for (const [fail, disposeFail] of [[false, false], [true, false], [false, true], [true, true]]) {
      await writeFile(events, "", "utf8");
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(hook).href, "dist/cli.js", "--terminal-cell-presentation=explicit", "about:newtab"
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

try {
  await runSmokeCheck();
  await verifyCliHostOwnership();
  const invalidOption = spawnSync(process.execPath, ["dist/cli.js", "--unknown-option"], {
    encoding: "utf8"
  });
  if (invalidOption.status !== 1 || !invalidOption.stderr.includes("Unknown option: --unknown-option")) {
    throw new Error("CLI did not reject an unknown option");
  }
  const invalidPresentation = spawnSync(process.execPath, [
    "dist/cli.js", "--terminal-cell-presentation=implicit"
  ], { encoding: "utf8" });
  if (invalidPresentation.status !== 1 || !invalidPresentation.stderr.includes("Unknown option:")) {
    throw new Error("CLI must reject unsupported terminal-state declarations.");
  }
  process.stdout.write("cli smoke ok\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cli-smoke failed: ${message}\n`);
  process.exit(1);
}
