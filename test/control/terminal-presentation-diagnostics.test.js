import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { terminalPresentationDiagnostics } from "../../dist/ui/terminal-presentation.js";

for (const report of [1, 2]) test(`browser diagnostics label assumed presentation and pre-acquisition raw mode ${report}`, async (t) => {
  const host = createMemoryTerminalHost({ env: { TERM: "xterm-256color" } });
  t.after(() => host.dispose());
  let queries = 0;
  const write = host.stdout.write.bind(host.stdout);
  host.stdout.write = async (chunk, context) => {
    await write(chunk, context);
    const requests = [...String(chunk).matchAll(/\[(\??)(\d+)\$p/gu)];
    for (const [, prefix, mode] of requests) {
      queries++;
      host.input(`\u001b[${prefix}${mode};${prefix === "" && mode === "8" ? report : 2}$y`);
    }
    if (requests.length > 0) host.input("\u001b[?1;2c");
  };
  const capabilities = await host.getCapabilities({ activeProbes: ["terminalModes"] });
  const count = queries;
  const lines = terminalPresentationDiagnostics(capabilities);
  assert.ok(lines.includes("Terminal presentation: supported"));
  assert.ok(lines.includes("Terminal evidence: capability snapshot before session acquisition"));
  assert.ok(lines.some((line) => line.includes("evidence") && line.includes("assumed")));
  assert.ok(lines.some((line) => line.includes("standard:8 (probe)") && line.includes(report === 1 ? "set" : "reset")));
  assert.ok(lines.some((line) => line.includes("decision") && line.includes(report === 1 ? "reset-required" : "admitted")));
  assert.ok(!lines.some((line) => line.includes("context:")));
  assert.equal(queries, count, "diagnostics must consume the session snapshot without probing");
  assert.deepEqual(terminalPresentationDiagnostics(undefined), []);
});
