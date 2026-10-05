import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { TuiRunError } from "@ismail-elkorchi/terminal-ui/tui";

import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { runBrowserTui } from "../../dist/ui/run.js";

test("browser preserves actionable terminal setup failure and closes its resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verge-terminal-startup-"));
  const host = createMemoryTerminalHost({
    capabilities: { overrides: { cellPresentation: false } }
  });
  host.input("\u001b[8;0$y\u001b[?1;2c");
  let servicesClosed = 0;
  try {
    const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
    await assert.rejects(runBrowserTui("about:newtab", {
      host,
      store,
      services: {
        async writeTextFile() {},
        async downloadFile() { throw new Error("unexpected download"); },
        async openExternal() {},
        async openPath() {},
        async close() { servicesClosed += 1; }
      },
      createAcquisition: () => new PageAcquisition()
    }), (error) => {
      assert.ok(error instanceof TuiRunError);
      const failure = error.exit.diagnostics.find(({ diagnostic }) =>
        diagnostic.data?.operation === "cellPresentation"
        && diagnostic.data.requirement === "required"
      );
      assert.ok(failure);
      assert.ok(error.message.includes(failure.diagnostic.message));
      assert.notEqual(error.message, "Required terminal session protocol setup failed.");
      return true;
    });
    assert.equal(servicesClosed, 1);
    assert.equal(host.stdin.isRawModeEnabled(), false);
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
