import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import test from "node:test";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { defaultTheme, highContrastTheme } from "@ismail-elkorchi/terminal-ui/theme";
import { createTuiRuntime } from "@ismail-elkorchi/terminal-ui/tui";
import { HttpFields } from "@ismail-elkorchi/http-client";
import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { prepareBrowserTui } from "../../dist/ui/run.js";

async function waitUntil(runtime, predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, JSON.stringify(runtime.diagnostics()));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(html, theme = defaultTheme) {
  const old = { NO_COLOR: env.NO_COLOR, TERM: env.TERM, COLORTERM: env.COLORTERM };
  delete env.NO_COLOR; env.TERM = "xterm-256color"; env.COLORTERM = "truecolor";
  const directory = await mkdtemp(join(tmpdir(), "verge-control-paint-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const prepared = await prepareBrowserTui("https://native.test/", { store,
    services: { async writeTextFile() {}, async downloadFile() { throw new Error("not used"); }, async openExternal() {}, async openPath() {}, async close() {} },
    createAcquisition: () => new PageAcquisition({ defaultParseMode: "text", stylesheetLoader: async () => { throw new Error("not used"); }, loader: async (url) => ({
      requestUrl: url, finalUrl: url, status: 200, statusText: "OK", contentType: "text/html", html,
      responseFields: new HttpFields([{ name: "content-type", value: "text/html" }]),
      networkOutcome: { kind: "ok", finalUrl: url, status: 200, statusText: "OK", detailCode: "HTTP_200", detailMessage: "OK" }, fetchedAtIso: "2026-10-04T00:00:00.000Z",
    }) }) });
  const runtime = createTuiRuntime({ app: prepared.app, textPresentation: prepared.textPresentation, host: createMemoryTerminalHost({ terminalSize: { columns: 90, rows: 25 } }), theme });
  await runtime.start();
  await waitUntil(runtime, () => runtime.state().documents[0]?.rendering?.status === "ready");
  return { runtime, close: async () => { await runtime.dispose(); await prepared.controller.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete env[key]; else env[key] = value; } } };
}
const key = (value) => ({ kind: "key", key: value, sequence: "", modifiers: { shift: false, alt: false, ctrl: false, meta: false }, eventType: "press", location: "standard" });

for (const [name, theme] of [["default", defaultTheme], ["high-contrast", highContrastTheme]]) {
  for (const [canvas, foreground, rgb] of [["white", "#222", 34], ["#111", "#eee", 238]]) {
    test(`${name} native controls pair foreground with ${canvas} authored canvas and retain adjacent labels`, async () => {
      const { runtime, close } = await fixture(`<style>body{margin:4px;line-height:1.5;background:${canvas};color:${foreground}}input:focus{background:#ffffcb;color:#222}</style>
        <form><input id=q size=10><br><input type=radio checked><label>Package names only</label><br><select id=s><option>stable</option><option>testing</option></select><textarea rows=3>界 first\nsecond</textarea></form>`, theme);
      try {
        const plain = renderFramePlain(runtime.frame());
        assert.ok(plain.includes("Package names only"), plain);
        assert.ok(plain.includes("stable"), plain);
        const native = runtime.frame().cells.find((cell) => cell.source?.elementId === runtime.state().documents[0].snapshot.document.elementById("s") && cell.text === "s" && cell.style?.fg?.kind === "rgb" && cell.style.fg.r === rgb);
        assert.ok(native, JSON.stringify(runtime.frame().cells.filter((cell) => cell.text === "s")));
        assert.equal(native.style.fg.r, native.style.fg.g);
        const document = runtime.state().documents[0];
        const input = document.snapshot.document.elementById("q"), select = document.snapshot.document.elementById("s");
        await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
        await waitUntil(runtime, () => runtime.frame().focusPath?.includes(input) && runtime.state().documents[0].rendering.status === "ready");
        assert.equal(runtime.state().documents[0].rendering.viewport.controls.find((entry) => entry.node === input).allocation.height, 1);
        assert.ok(renderFramePlain(runtime.frame()).includes("Package names only"));
        await runtime.dispatch({ kind: "formComboboxTransition", controlId: select, transition: { kind: "open" } });
        assert.ok(renderFramePlain(runtime.frame()).includes("testing"));
        await runtime.dispatch({ kind: "formComboboxTransition", controlId: select, transition: { kind: "dismiss", reason: "escape" } });
        assert.ok(renderFramePlain(runtime.frame()).includes("Package names only"));
      } finally { await close(); }
    });
  }
}

test("huge authored control allocation remains bounded to visible native paint and preserves editor state", async () => {
  const { runtime, close } = await fixture('<style>body{margin:0}.clip{width:160px;height:48px;overflow:hidden}input{width:8000000px}</style><div class=clip><input id=q value="界alpha"></div>');
  try {
    const id = runtime.state().documents[0].snapshot.document.elementById("q");
    assert.ok(runtime.state().documents[0].rendering.viewport.controls[0].allocation.width > 100000);
    assert.ok(runtime.frame().cells.length <= 90 * 25);
    await runtime.dispatch({ kind: "movePageFocus", direction: "next", currentActionId: "" });
    await waitUntil(runtime, () => runtime.frame().focusPath?.includes(id));
    await runtime.handleInput(key("end"));
    await runtime.handleInput({ kind: "text", text: "Z", paste: false });
    const editor = runtime.state().documents[0].formEditors[id];
    await runtime.resize({ columns: 60, rows: 20 });
    await waitUntil(runtime, () => runtime.state().documents[0].rendering.status === "ready");
    assert.equal(runtime.state().documents[0].formEditors[id], editor);
    assert.ok(runtime.frame().focusPath?.includes(id));
    assert.ok(runtime.frame().cells.length <= 60 * 20);
  } finally { await close(); }
});

for (const content of ['', '<p>Short page</p>']) {
  test(`mounted canvas fills the browser viewport beyond ${content === '' ? 'empty' : 'short'} document extent`, async () => {
    const { runtime, close } = await fixture(`<style>body{margin:8px;background:white;color:#222}</style>${content}`);
    try {
      const current = () => runtime.state().documents[0];
      const extent = current().rendering.summary.documentRowCount;
      assert.ok(extent < 10, `short document remains short: ${extent}`);
      const painted = (row) => runtime.frame().cells.find((cell) => cell.row === row && cell.column === 2)?.style?.bg;
      const white = { kind: 'rgb', r: 255, g: 255, b: 255 };
      assert.deepEqual(painted(24), white, 'last page row above browser status uses the canvas');
      await runtime.dispatch({ kind: 'scrollTo', row: 999 });
      await waitUntil(runtime, () => current().rendering.status === 'ready');
      assert.equal(current().rendering.summary.documentRowCount, extent);
      assert.equal(current().rendering.viewport.scrollRow, 0);
      assert.deepEqual(painted(24), white);
      await runtime.resize({ columns: 90, rows: 35 });
      await waitUntil(runtime, () => current().rendering.status === 'ready');
      assert.equal(current().rendering.summary.documentRowCount, extent);
      assert.deepEqual(painted(34), white, 'resized canvas reaches the new last page row');
    } finally { await close(); }
  });
}

test('reset native focus clears the previous editor authored focus background', async () => {
  const { runtime, close } = await fixture('<style>body{background:white;color:#222}input:focus{background:#ffffcb}</style><form><input id=q><input id=reset type=reset value=Reset></form>');
  try {
    const current = () => runtime.state().documents[0];
    const document = current().snapshot.document;
    const input = document.elementById('q'), reset = document.elementById('reset');
    const ready = () => current().rendering.status === 'ready' && current().rendering.viewport.stateRevision === current().stateRevision;
    await runtime.dispatch({ kind: 'movePageFocus', direction: 'next', currentActionId: '' });
    await waitUntil(runtime, () => ready() && runtime.frame().focusPath?.includes(input));
    await runtime.handleInput({ kind: 'text', text: 'curl', paste: false });
    await waitUntil(runtime, ready);
    assert.equal(current().documentState.focus, input);
    assert.equal(current().rendering.viewport.controls.find((entry) => entry.node === input).style.background, null);
    assert.ok(runtime.frame().cells.some((cell) => cell.source?.elementId === input
      && cell.style?.bg?.kind === 'rgb' && cell.style.bg.r === 255 && cell.style.bg.g === 255 && cell.style.bg.b === 203),
    JSON.stringify({ control: current().rendering.viewport.controls.find((entry) => entry.node === input),
      cells: runtime.frame().cells.filter((cell) => cell.source?.elementId === input).slice(0, 12) }));
    const target = runtime.frame().hitTargets.find((entry) => entry.id === reset || entry.id.startsWith(`${reset}:`));
    assert.ok(target, JSON.stringify(runtime.frame().hitTargets.map((entry) => ({id:entry.id,bounds:entry.bounds}))));
    for (const action of ['press', 'release']) await runtime.handleInput({ kind: 'mouse', sequence: '', encoding: 'sgr', action,
      button: 'left', row: target.bounds.row, column: target.bounds.column, rawCode: 0, modifiers: { shift: false, alt: false, ctrl: false } });
    await waitUntil(runtime, () => ready() && runtime.frame().focusPath?.includes(reset));
    assert.equal(current().documentState.focus, reset);
    assert.equal(current().documentState.controls.get(input).value, '');
    assert.equal(current().rendering.viewport.controls.find((entry) => entry.node === input).style.background, null);
    assert.equal(current().rendering.viewport.controls.find((entry) => entry.node === reset).style.background, null);
    const cells = runtime.frame().cells.filter((cell) => cell.source?.elementId === input);
    assert.ok(cells.length > 0);
    assert.ok(cells.every((cell) => cell.style?.bg?.b !== 203));
  } finally { await close(); }
});

test('opacity-zero native form controls keep input and focus without ink or cursor', async () => {
  const { runtime, close } = await fixture('<style>body{margin:0;background:white;color:black}.hidden{opacity:0}input:focus{background:red}</style><p>VISIBLE</p><div class=hidden><input id=q value="SECRET"><input id=c type=checkbox aria-label="Hidden choice"><span>HIDDEN_LABEL</span></div>');
  try {
    const current = () => runtime.state().documents[0];
    const document = current().snapshot.document;
    const input = document.elementById('q'), checkbox = document.elementById('c');
    const ready = () => current().rendering.status === 'ready' && current().rendering.viewport.stateRevision === current().stateRevision;
    assert.ok(renderFramePlain(runtime.frame()).includes('VISIBLE'));
    assert.ok(!renderFramePlain(runtime.frame()).includes('SECRET'));
    assert.ok(!renderFramePlain(runtime.frame()).includes('HIDDEN_LABEL'));
    assert.equal(current().rendering.viewport.controls.find((entry) => entry.node === input).paintSuppressed, true);
    await runtime.dispatch({ kind: 'movePageFocus', direction: 'next', currentActionId: '' });
    await waitUntil(runtime, () => ready() && runtime.frame().focusPath?.includes(input));
    assert.equal(runtime.frame().cursor, undefined);
    await runtime.handleInput(key('end'));
    await runtime.handleInput({ kind: 'text', text: 'X', paste: false });
    await waitUntil(runtime, ready);
    assert.equal(current().documentState.controls.get(input).value, 'SECRETX');
    assert.ok(!renderFramePlain(runtime.frame()).includes('SECRET'));
    assert.equal(runtime.frame().cursor, undefined);
    const target = runtime.frame().hitTargets.find((entry) => entry.id === checkbox || entry.id.startsWith(`${checkbox}:`));
    assert.ok(target);
    for (const action of ['press', 'release']) await runtime.handleInput({ kind: 'mouse', sequence: '', encoding: 'sgr', action,
      button: 'left', row: target.bounds.row, column: target.bounds.column, rawCode: 0, modifiers: { shift: false, alt: false, ctrl: false } });
    await waitUntil(runtime, ready);
    assert.equal(current().documentState.controls.get(checkbox).checked, true);
    assert.equal(runtime.frame().cursor, undefined);
    assert.ok(!runtime.frame().cells.some((cell) => cell.source?.elementId === input || cell.source?.elementId === checkbox));
  } finally { await close(); }
});
