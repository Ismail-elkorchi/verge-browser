import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { URL } from "node:url";

// Keep adversarial authored dimensions out of the test runner's own heap/thread.
// The logical editor allocation must stay huge; only committed paint is bounded.
for (const [name, html, expected] of [
  ["textarea", '<textarea rows="2147483647" cols="2147483647">small</textarea>', "small"],
  ["input", '<input size="2147483647" value="small">', "small"],
  ["number", '<input type="number" value="12" style="width:2147483647px">', "12"],
  ["button", '<button style="width:2147483647px">small</button>', "small"],
  ["checkbox", '<input type="checkbox" checked style="width:2147483647px" aria-label="Choice">', "☑"],
  ["radio", '<input type="radio" checked style="width:2147483647px" aria-label="Choice">', "◉"],
]) test(`huge declared ${name} allocation paints only its clipped viewport`, () => {
  const moduleUrl = (path) => new URL(`../../dist/${path}`, import.meta.url).href;
  const directory = mkdtempSync(join(tmpdir(), "verge-control-budget-"));
  const script = join(directory, "render.mjs");
  writeFileSync(script, `
    import { join } from "node:path";
    import { HttpFields } from ${JSON.stringify(import.meta.resolve("@ismail-elkorchi/http-client"))};
    import { BrowserStore } from ${JSON.stringify(moduleUrl("app/storage.js"))};
    import { PageAcquisition } from ${JSON.stringify(moduleUrl("app/page-acquisition.js"))};
    import { renderBrowserOnce } from ${JSON.stringify(moduleUrl("ui/run.js"))};
    const directory = ${JSON.stringify(directory)};
    const store = await BrowserStore.open({statePath:join(directory,"state.json")});
    const output = await renderBrowserOnce("https://example.test/", {
      store, services:{async close(){}},
      createAcquisition:()=>new PageAcquisition({defaultParseMode:"text", loader:async url=>({
        requestUrl:url, finalUrl:url, status:200, statusText:"OK", contentType:"text/html",
        html:${JSON.stringify('<style>body{margin:0}.clip{width:80px;height:32px;overflow:hidden}</style><div class="clip">'+html+'</div>')},
        responseFields:new HttpFields([{name:"content-type",value:"text/html"}]),
        networkOutcome:{kind:"ok",finalUrl:url,status:200,statusText:"OK",detailCode:"HTTP_200",detailMessage:"200 OK"},
        fetchedAtIso:"2026-01-01T00:00:00.000Z"
      })})
    }, {columns:80,rows:24});
    if (!output.includes(${JSON.stringify(expected)})) throw new Error("Clipped control did not paint its visible value: " + output);
    process.stdout.write("bounded native control painted");
  `);
  const child = spawnSync(process.execPath, ["--max-old-space-size=192", script], { encoding: "utf8", timeout: 15_000, maxBuffer: 1_000_000 });
  rmSync(directory, { recursive: true, force: true });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "bounded native control painted");
});
