import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNodeHost } from "../../dist/runtime/node-host.js";
import { createDenoHost } from "../../dist/runtime/deno-host.js";
import { createBunHost } from "../../dist/runtime/bun-host.js";

test("node host reads local text files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verge-host-"));
  try {
    const filePath = join(dir, "sample.txt");
    await writeFile(filePath, "alpha\n", "utf8");

    const host = createNodeHost();
    assert.equal(host.name, "node");
    const value = await host.readFileText(filePath);
    assert.equal(value, "alpha\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deno host fails with explicit message when Deno API is unavailable", async () => {
  const host = createDenoHost();
  await assert.rejects(host.readFileText("/tmp/missing"), /Deno runtime API is unavailable/);
});

test("bun host fails with explicit message when Bun API is unavailable", async () => {
  const host = createBunHost();
  await assert.rejects(host.readFileText("/tmp/missing"), /Bun runtime API is unavailable/);
});
