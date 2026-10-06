import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { BrowserStore } from "../../dist/app/storage.js";

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
    async settings() { return (await BrowserStore.open({ statePath })).terminalSettings(); },
    run(args, environment = environments.kitty, tty = true) {
      return spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, fileURLToPath(cli), ...args], {
        encoding: "utf8", timeout: 8000,
        env: { ...process.env, XDG_STATE_HOME: join(directory, "state"), CLI_EVENTS: events,
          CLI_ENV: JSON.stringify(environment), CLI_TTY: tty ? "1" : "0" }
      });
    }
  };
}

test("one-time setting commands save matching conditions and revoke one condition without terminal access", async (t) => {
  const f = await fixture(t);
  for (const [environment, condition] of [[environments.kitty, "kitty-force-ltr"], [environments.konsole, "konsole-bidi-disabled"]]) {
    const result = f.run([`--remember-terminal-setting=${condition}`], environment);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Remembered ${condition}`));
    assert.ok(result.stdout.includes("must already be configured"));
    assert.ok(result.stdout.includes("all direct sessions sharing this recorded terminal identity and version"));
    assert.ok(result.stdout.includes("including other windows and profiles"));
    assert.ok(result.stdout.includes("replaces that condition's previous saved context"));
    assert.ok(result.stdout.includes("temporary launch override is not sufficient"));
    assert.ok(result.stdout.includes("user-maintained assumption, not a verified setting"));
  }
  const settings = await f.settings();
  assert.equal(settings.length, 2);
  assert.notEqual(settings[0].context, settings[1].context);
  const forgotten = f.run(["--forget-terminal-setting=kitty-force-ltr"], environments.conventional, false);
  assert.equal(forgotten.status, 0, forgotten.stderr);
  assert.ok(forgotten.stdout.includes("regardless of its recorded terminal context"));
  assert.deepEqual(await f.settings(), settings.filter((entry) => entry.condition === "konsole-bidi-disabled"));
  assert.equal(f.run(["--forget-terminal-setting=kitty-force-ltr"], environments.conventional, false).status, 0);
  assert.equal(await readFile(f.events, "utf8"), "dispose\ndispose\n");
});

test("remembered assumptions deliberately share the documented identity scope across direct windows and profiles", async (t) => {
  const f = await fixture(t);
  const first = { ...environments.kitty, KITTY_WINDOW_ID: "1", KITTY_CONFIG_DIRECTORY: "/profiles/first" };
  const other = { ...environments.kitty, KITTY_WINDOW_ID: "2", KITTY_CONFIG_DIRECTORY: "/profiles/other" };
  const remembered = f.run(["--remember-terminal-setting=kitty-force-ltr"], first);
  assert.equal(remembered.status, 0, remembered.stderr);
  const settings = await f.settings();
  const host = createMemoryTerminalHost({ env: other, capabilities: { cellPresentation: { exceptions: settings } } });
  t.after(() => host.dispose());
  const presentation = (await host.getCapabilities()).cellPresentation;
  assert.equal(presentation.support, "supported");
  assert.equal(presentation.facts.find((fact) => fact.name === "cellPresentation.context").value, settings[0].context);
  assert.equal(presentation.facts.find((fact) => fact.name === "cellPresentation.evidence").value, "assumed");
  const forgotten = f.run(["--forget-terminal-setting=kitty-force-ltr"], other);
  assert.equal(forgotten.status, 0, forgotten.stderr);
  assert.deepEqual(await f.settings(), []);
});

test("condition revocation does not parse its record, unrelated assertions or browser state", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.statePath), { recursive: true, mode: 0o700 });
  const kittyPath = `${f.statePath}.terminal-kitty-force-ltr.json`;
  const konsolePath = `${f.statePath}.terminal-konsole-bidi-disabled.json`;
  await mkdir(f.statePath);
  await mkdir(konsolePath);
  await writeFile(kittyPath, "x".repeat(32 * 1024 + 1));
  const forgotten = f.run(["--forget-terminal-setting=kitty-force-ltr"], environments.conventional, false);
  assert.equal(forgotten.error, undefined);
  assert.equal(forgotten.status, 0, forgotten.stderr);
  await assert.rejects(readFile(kittyPath), { code: "ENOENT" });
  assert.equal((await stat(f.statePath)).isDirectory(), true);
  assert.equal((await stat(konsolePath)).isDirectory(), true);
  await assert.rejects(readFile(f.events), { code: "ENOENT" });
});

test("condition revocation unlinks a symlink without reading or changing its target", {
  skip: process.platform === "win32" ? "Windows symlink creation requires additional privileges" : false
}, async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.statePath), { recursive: true, mode: 0o700 });
  const target = join(dirname(f.statePath), "unrelated.json");
  const settingPath = `${f.statePath}.terminal-kitty-force-ltr.json`;
  await writeFile(target, "unrelated content");
  await symlink(target, settingPath);
  const forgotten = f.run(["--forget-terminal-setting=kitty-force-ltr"], environments.conventional, false);
  assert.equal(forgotten.status, 0, forgotten.stderr);
  assert.equal(await readFile(target, "utf8"), "unrelated content");
  await assert.rejects(readFile(settingPath), { code: "ENOENT" });
  await assert.rejects(readFile(f.events), { code: "ENOENT" });
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
  const oldForget = f.run(["--forget-terminal-settings"]);
  assert.equal(oldForget.status, 1);
  assert.match(oldForget.stderr, /Unknown option: --forget-terminal-settings/u);
  for (const args of [
    ["--remember-terminal-setting=anything"],
    ["--remember-terminal-setting=kitty-force-ltr", "--once"],
    ["--forget-terminal-setting=anything"],
    ["--forget-terminal-setting=kitty-force-ltr", "about:newtab"],
    ["--forget-terminal-setting=kitty-force-ltr", "--once"],
    ["--forget-terminal-setting=kitty-force-ltr", "--forget-terminal-setting=konsole-bidi-disabled"],
    ["--remember-terminal-setting=kitty-force-ltr", "--forget-terminal-setting=kitty-force-ltr"]
  ]) assert.equal(f.run(args).status, 1);
  await assert.rejects(readFile(f.events), { code: "ENOENT" });
});
