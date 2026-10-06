import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import test from "node:test";

test("actual one-shot CLI preserves image fallback without claiming live acquisition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "verge-once-image-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = join(directory, "page.html");
  await writeFile(page, '<title>Snapshot</title><style>body{margin:0}.icon{display:block;width:16px;height:16px;'
    + 'background:black;mask-image:url(https://images.test/mask.svg);mask-size:contain;mask-repeat:no-repeat}</style>'
    + '<p>Readable snapshot text</p><img src="https://images.test/a.png" width="80" height="16" alt="IMAGE_ALT">'
    + '<span class="icon"></span>');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
    "--once", pathToFileURL(page).href], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, XDG_STATE_HOME: join(directory, "state"), COLUMNS: "100", LINES: "24" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Readable snapshot text/u);
  assert.match(result.stdout, /IMAGE_ALT/u);
  assert.doesNotMatch(result.stdout, /Loading images|mask-intrinsics-pending|rendering incomplete/u);
  assert.equal(result.stdout.includes("\u001b_G"), false);
});
