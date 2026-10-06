import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { TuiRunError } from "@ismail-elkorchi/terminal-ui/tui";

import { BrowserStore } from "../../dist/app/storage.js";
import { prepareBrowserTui, renderBrowserOnce, runBrowserTui } from "../../dist/ui/run.js";

function blockedHost() {
  const host = createMemoryTerminalHost({ env: { TERM: "xterm-kitty", KITTY_WINDOW_ID: "1" } });
  const write = host.stdout.write.bind(host.stdout);
  host.stdout.write = async (chunk, context) => {
    await write(chunk, context);
    const queries = [...String(chunk).matchAll(/\[(\??)(\d+)\$p/gu)];
    if (queries.length > 0) {
      host.input(`${queries.map(([, prefix, mode]) => `\u001b[${prefix}${mode};0$y`).join("")}\u001b[?1;2c`);
    }
  };
  return host;
}

async function fixture(t, { servicesFailure, flushFailure } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-startup-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const host = blockedHost();
  const calls = { services: 0, flush: 0, acquisitions: 0 };
  const flush = store.flush.bind(store);
  store.flush = async () => {
    calls.flush += 1;
    if (flushFailure !== undefined) throw flushFailure;
    await flush();
  };
  t.after(async () => {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    host, store, calls,
    options: {
      host, store,
      services: {
        async writeTextFile() {},
        async downloadFile() { throw new Error("unexpected download"); },
        async openExternal() {},
        async openPath() {},
        async close() {
          calls.services += 1;
          if (servicesFailure !== undefined) throw servicesFailure;
        }
      },
      createAcquisition: () => {
        calls.acquisitions += 1;
        throw new Error("Page acquisition must not begin before terminal admission.");
      }
    }
  };
}

function assertFailedAdmission(f) {
  assert.equal(f.calls.services, 1);
  assert.equal(f.calls.flush, 1);
  assert.equal(f.calls.acquisitions, 0);
  assert.equal(f.host.frames().length, 0);
  assert.equal(f.host.stdin.isRawModeEnabled(), false);
  assert.equal(f.host.restores().at(-1).status, "restored");
}

function assertPrimaryFailure(error) {
  assert.ok(error instanceof TuiRunError);
  const failure = error.primaryDiagnostic;
  assert.ok(failure);
  assert.equal(failure.code, "HOST_CELL_PRESENTATION_CONTRADICTED");
  assert.equal(failure.data.operation, "cellPresentation");
  assert.equal(failure.data.requirement, "required");
  assert.equal(failure.data.outcome, "rejected");
  assert.ok(error.message.startsWith(failure.message));
  assert.equal(error.cause, failure.cause);
  assert.ok(error.exit.diagnostics.some((entry) => entry.diagnostic === failure));
}

test("actual browser startup preserves actionable terminal failure when resource cleanup succeeds", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runBrowserTui("https://example.test/", f.options), (error) => {
    assertPrimaryFailure(error);
    return true;
  });
  assertFailedAdmission(f);
});

for (const failures of ["services", "flush", "both"]) {
  test(`actual browser startup preserves terminal failure and ${failures} cleanup failure`, async (t) => {
    const servicesFailure = new Error("services close failed");
    const flushFailure = new Error("store flush failed");
    const f = await fixture(t, {
      ...(failures === "flush" ? {} : { servicesFailure }),
      ...(failures === "services" ? {} : { flushFailure })
    });
    await assert.rejects(runBrowserTui("https://example.test/", f.options), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.cause, error.errors[0]);
      assertPrimaryFailure(error.cause);
      if (failures === "both") {
        assert.ok(error.errors[1] instanceof AggregateError);
        assert.deepEqual(error.errors[1].errors, [servicesFailure, flushFailure]);
      } else {
        assert.equal(error.errors[1], failures === "services" ? servicesFailure : flushFailure);
      }
      return true;
    });
    assertFailedAdmission(f);
  });
}

for (const cleanupFails of [false, true]) {
  test(`browser preparation retains its original failure when cleanup ${cleanupFails ? "fails" : "succeeds"}`, async (t) => {
    const primary = new Error("workspace read failed");
    const cleanup = new Error("services close failed");
    const f = await fixture(t, cleanupFails ? { servicesFailure: cleanup } : {});
    f.store.workspace = () => { throw primary; };
    await assert.rejects(prepareBrowserTui("about:newtab", { ...f.options, restoreWorkspace: true }), (error) => {
      if (cleanupFails) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, cleanup]);
      } else {
        assert.equal(error, primary);
      }
      return true;
    });
    assert.equal(f.calls.services, 1);
    assert.equal(f.calls.flush, 1);
    assert.equal(f.calls.acquisitions, 0);
    assert.equal(f.host.frames().length, 0);
    assert.equal(f.host.restores().length, 0);
  });
}

test("one-shot browser rendering preserves both acquisition and cleanup failure", async (t) => {
  const primary = new Error("page acquisition failed");
  const cleanup = new Error("store flush failed");
  const f = await fixture(t, { flushFailure: cleanup });
  await assert.rejects(renderBrowserOnce("https://example.test/", {
    ...f.options,
    createAcquisition: () => { throw primary; }
  }, { columns: 80, rows: 24 }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.deepEqual(error.errors, [primary, cleanup]);
    return true;
  });
  assert.equal(f.calls.services, 1);
  assert.equal(f.calls.flush, 1);
});
