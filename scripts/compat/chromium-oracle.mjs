import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_VARIANTS, ROW_HEIGHT_CSS_PX, fixtureRequestUrl, fixtureResources, mediaEnvironment } from "./environment.mjs";
import { compareOracleCase } from "./oracle-comparison.mjs";
import { collectBrowserFormObservations, chromiumAccessibleNames } from "./form-observations.mjs";
import { collectVisibleBrowserText } from "./browser-text.mjs";
import { openFixture, renderSnapshot, paintExpectations } from "./run.mjs";
import { nativeInspection } from "./native-observations.mjs";

const executablePath = process.env.CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error("Set CHROMIUM_EXECUTABLE to an installed local Chromium executable.");
let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? "playwright-core"));
} catch {
  throw new Error("Optional oracle requires a developer-installed playwright-core package (or PLAYWRIGHT_CORE_PATH); it is not a Verge dependency.");
}
const options = { check: false, classifyScriptRequired: false, report: "reports/compatibility-chromium.json", fixture: null };
for (const argument of process.argv.slice(2)) {
  if (argument === "--check") options.check = true;
  else if (argument === "--classify-script-required") options.classifyScriptRequired = true;
  else if (argument.startsWith("--report=")) options.report = argument.slice("--report=".length);
  else if (argument.startsWith("--fixture=")) options.fixture = argument.slice("--fixture=".length);
  else throw new Error(`Unsupported Chromium oracle argument: ${argument}`);
}
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await readFile(resolve(scriptDirectory, "corpus.json"), "utf8"));
const fixtures = corpus.fixtures.filter((fixture) => options.fixture === null || fixture.id === options.fixture);
if (fixtures.length === 0) throw new Error(`Unknown fixture: ${options.fixture}`);

async function checkedBytes(entry) {
  const bytes = await readFile(resolve(scriptDirectory, entry.file));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== entry.sha256) throw new Error(`Fixture/resource checksum mismatch for ${entry.file}: ${hash}`);
  return bytes;
}

const browser = await chromium.launch({ executablePath, headless: true });
const inspect = async (javaScriptEnabled) => {
  const context = await browser.newContext({ javaScriptEnabled, locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "no-preference", isMobile: false, hasTouch: false });
  const values = [];
  try {
    for (const fixture of fixtures) {
      const html = await checkedBytes(fixture);
      const resourceByUrl = new Map();
      for (const resource of fixtureResources(fixture, corpus)) {
        const entry = { ...resource, bytes: await checkedBytes(resource) };
        resourceByUrl.set(resource.requestUrl, entry);
        if (resource.finalUrl !== undefined) resourceByUrl.set(resource.finalUrl, { ...entry, requestUrl: resource.finalUrl });
      }
      for (const variant of fixture.variants ?? DEFAULT_VARIANTS) {
        const environment = mediaEnvironment(variant);
        const page = await context.newPage();
        try {
          await page.setViewportSize({ width: environment.viewportWidthCssPx, height: environment.viewportHeightCssPx });
          await page.emulateMedia({ media: environment.mediaType });
          const stylesheetRequests = [];
          const blockedRequests = [];
          const requestUrl = fixtureRequestUrl(fixture);
          await page.route("**/*", async (route) => {
            const url = route.request().url();
            if (url === requestUrl) {
              await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
              return;
            }
            const resource = resourceByUrl.get(url);
            if (resource === undefined) {
              blockedRequests.push(url);
              await route.abort("blockedbyclient");
              return;
            }
            stylesheetRequests.push(url);
            if (resource.finalUrl !== undefined && url !== resource.finalUrl) {
              await route.fulfill({ status: 302, headers: { location: resource.finalUrl }, body: "" });
              return;
            }
            await route.fulfill({ status: 200, contentType: resource.transportEncodingLabel === undefined ? "text/css" : `text/css; charset=${resource.transportEncodingLabel}`, body: resource.bytes });
          });
          await page.goto(requestUrl, { waitUntil: "load" });
          await page.evaluate((scrollY) => globalThis.scrollTo(0, scrollY), variant.scrollRow * ROW_HEIGHT_CSS_PX);
          const inspection = await page.evaluate(() => {
            const document = globalThis.document;
            const computedStyle = globalThis.getComputedStyle;
            const elements = [...document.querySelectorAll("body *")];
            const visible = (element) => {
              const style = computedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== "none" && style.visibility === "visible" && rect.width > 0 && rect.height > 0;
            };
            const box = (element) => {
              const rect = element.getBoundingClientRect();
              const style = computedStyle(element);
              return { tag: element.tagName.toLowerCase(), id: element.id,
                rectangle: { x: rect.x + globalThis.scrollX, y: rect.y + globalThis.scrollY, width: rect.width, height: rect.height },
                style: Object.fromEntries(["display", "visibility", "fontSize", "lineHeight", "color", "backgroundColor", "direction", "whiteSpace", "fontWeight", "overflowX", "overflowY", "contain", "listStyleType", "listStylePosition"].map((property) => [property, style[property]])) };
            };
            return {
              url: document.URL, compatibilityMode: document.compatMode,
              headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((element) => element.textContent?.trim() ?? ""),
              landmarks: elements.filter((element) => ["HEADER", "NAV", "MAIN", "ASIDE", "FOOTER", "FORM"].includes(element.tagName) && visible(element)).map((element) => element.getAttribute("role") ?? element.tagName.toLowerCase()),
              links: [...document.links].filter(visible).map((element) => ({ text: element.textContent?.trim() ?? "", href: element.href })),
              controls: [...document.querySelectorAll("input,select,textarea,button")].filter(visible).map((element) => ({ tag: element.tagName.toLowerCase(), name: element.getAttribute("name") ?? "" })),
              principalBoxes: elements.filter(visible).map(box),
              byId: Object.fromEntries(elements.filter((element) => element.id).map((element) => [element.id, box(element)])),
              stylesheets: [...document.styleSheets].map((sheet) => sheet.href ?? "embedded")
            };
          });
          Object.assign(inspection, await page.evaluate(collectVisibleBrowserText));
          inspection.formSemantics = await page.evaluate(collectBrowserFormObservations);
          inspection.accessibleNames = await chromiumAccessibleNames(context, page, inspection.formSemantics.nameTargets);
          let native = null;
          let comparison = null;
          if (!javaScriptEnabled) {
            const snapshot = await openFixture(fixture, html.toString("utf8"), [], corpus);
            const pipeline = renderSnapshot(snapshot, variant, paintExpectations(fixture, variant));
            native = nativeInspection(fixture, variant, snapshot, pipeline);
            comparison = compareOracleCase(fixture, variant, native, inspection);
          }
          values.push({ id: `${fixture.id}:${variant.id}`, fixture: fixture.id, variant, environment, inspection, stylesheetRequests, blockedRequests, native, comparison });
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await context.close();
  }
  return values;
};
let scriptingDisabled;
let scriptingEnabled;
try {
  scriptingDisabled = await inspect(false);
  scriptingEnabled = options.classifyScriptRequired ? await inspect(true) : null;
} finally {
  await browser.close();
}
const failures = scriptingDisabled.flatMap((entry) => entry.comparison.failures.map((failure) => ({ case: entry.id, ...failure })));
const result = {
  schemaVersion: 3,
  chromiumExecutableHash: createHash("sha256").update(await readFile(executablePath)).digest("hex"),
  chromiumVersion: browser.version(),
  comparisonScope: "Native DOM form owners, sanitized values, option selectedness, ordered FormData entries, and CDP accessible names for opted-in fixtures; layout-visible DOM text, CSSOM generated strings, and native control text (not pixel occlusion) versus complete native painted-source coverage; expected text and explicit controlled computed-style/geometry assertions; no pixel equality or terminal font-metric equality.",
  summary: { caseCount: scriptingDisabled.length, comparedTextPhrases: scriptingDisabled.reduce((sum, entry) => sum + entry.comparison.comparedTextPhrases, 0), failures },
  scriptingDisabled, scriptingEnabled
};
const reportPath = resolve(options.report);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${reportPath}\n${JSON.stringify(result.summary)}\n`);
if (options.check && failures.length > 0) throw new Error("Chromium compatibility comparisons failed; inspect the machine-readable report.");
