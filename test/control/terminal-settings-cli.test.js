import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const cli = new URL("../../dist/cli.js", import.meta.url);
const hostUrl = import.meta.resolve("@ismail-elkorchi/terminal-ui/host");
const environments = {
  kitty: { TERM: "xterm-kitty", KITTY_WINDOW_ID: "1", TERM_PROGRAM: "kitty", TERM_PROGRAM_VERSION: "0.45.0" },
  konsole: { TERM: "xterm-256color", KONSOLE_VERSION: "250800" },
  conventional: { TERM: "xterm-256color" }
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-setting-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = join(directory, "events.txt");
  const sources = {
    "@ismail-elkorchi/terminal-ui/host": `import { createMemoryTerminalHost } from ${JSON.stringify(hostUrl)};
import { appendFileSync } from "node:fs";
export function createNodeTerminalHost(options) {
  const host = createMemoryTerminalHost({ ...options, env: JSON.parse(process.env.CLI_ENV), isTty: process.env.CLI_TTY !== "0" });
  host.stdin.setRawMode = () => { throw new Error("Setting commands must not acquire raw input."); };
  const dispose = host.dispose.bind(host);
  host.dispose = async () => { appendFileSync(process.env.CLI_EVENTS, "dispose\\n"); await dispose(); };
  return host;
}`,
    "./runtime/node-browser-services.js": `export function createNodeBrowserServices() { throw new Error("Setting commands must not create browser services."); }`
  };
  const modules = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name,
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`]));
  const hook = join(directory, "hook.mjs");
  await writeFile(hook, `import { registerHooks } from "node:module";
const modules = ${JSON.stringify(modules)};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === ${JSON.stringify(cli.href)} && Object.hasOwn(modules, specifier)) return { url: modules[specifier], shortCircuit: true };
  return next(specifier, context);
} });`);
  const statePath = join(directory, "state", "verge-browser", "state.json");
  return {
    events, statePath,
    run(args, environment = environments.kitty, tty = true) {
      return spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, fileURLToPath(cli), ...args], {
        encoding: "utf8", timeout: 8000,
        env: { ...process.env, XDG_STATE_HOME: join(directory, "state"), CLI_EVENTS: events,
          CLI_ENV: JSON.stringify(environment), CLI_TTY: tty ? "1" : "0" }
      });
    }
  };
}

test("one-time setting commands save only matching conditions and forget only the current context", async (t) => {
  const f = await fixture(t);
  for (const [environment, condition] of [[environments.kitty, "kitty-force-ltr"], [environments.konsole, "konsole-bidi-disabled"]]) {
    const result = f.run([`--remember-terminal-setting=${condition}`], environment);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Remembered ${condition}`));
    assert.ok(result.stdout.includes("must already be configured"));
  }
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.terminalSettings.length, 2);
  assert.notEqual(state.terminalSettings[0].context, state.terminalSettings[1].context);
  const forgotten = f.run(["--forget-terminal-settings"]);
  assert.equal(forgotten.status, 0, forgotten.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")).terminalSettings,
    state.terminalSettings.filter((entry) => entry.condition === "konsole-bidi-disabled"));
  assert.equal(await readFile(f.events, "utf8"), "dispose\ndispose\ndispose\n");
});

test("setting commands reject wrong terminal, ambiguous context and non-TTY without persisting", async (t) => {
  const f = await fixture(t);
  for (const [env, tty] of [[environments.conventional, true], [environments.konsole, true], [environments.kitty, false],
    [{ ...environments.kitty, TMUX: "/tmp/tmux-test,1,0" }, true]]) {
    const result = f.run(["--remember-terminal-setting=kitty-force-ltr"], env, tty);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /does not apply|cannot be identified safely/u);
  }
  await assert.rejects(readFile(f.statePath), { code: "ENOENT" });
  assert.equal(await readFile(f.events, "utf8"), "dispose\n".repeat(4));
});

test("removed presentation declarations and mixed setting commands are rejected", async (t) => {
  const f = await fixture(t);
  for (const value of ["existing", "mode-8-reset", "explicit"]) {
    const result = f.run([`--terminal-cell-presentation=${value}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option/u);
  }
  for (const args of [
    ["--remember-terminal-setting=anything"],
    ["--remember-terminal-setting=kitty-force-ltr", "--once"],
    ["--forget-terminal-settings", "about:newtab"],
    ["--remember-terminal-setting=kitty-force-ltr", "--forget-terminal-settings"]
  ]) assert.equal(f.run(args).status, 1);
  await assert.rejects(readFile(f.events), { code: "ENOENT" });
});
