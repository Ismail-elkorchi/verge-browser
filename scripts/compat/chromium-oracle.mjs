import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const executablePath = process.env.CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error("Set CHROMIUM_EXECUTABLE to an installed local Chromium executable.");
let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  throw new Error("Optional oracle requires a developer-installed playwright-core package; it is not a Verge dependency.");
}
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(await readFile(resolve(scriptDirectory, "corpus.json"), "utf8"));
const browser = await chromium.launch({ executablePath, headless: true });
const inspect = async (javaScriptEnabled) => {
  const context = await browser.newContext({ javaScriptEnabled });
  const values = [];
  for (const fixture of corpus.fixtures) {
    const path = resolve(scriptDirectory, fixture.file);
    const page = await context.newPage();
    await page.goto(pathToFileURL(path).href, { waitUntil: "load" });
    const inspection = await page.evaluate(() => {
      const browserDocument = globalThis.document;
      const computedStyle = globalThis.getComputedStyle;
      const visible = (element) => {
        const style = computedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const elements = [...browserDocument.querySelectorAll("body *")];
      return {
        meaningfulVisibleText: elements.filter(visible).map((element) => element.childElementCount === 0 ? element.textContent?.trim() ?? "" : "").filter(Boolean),
        headings: [...browserDocument.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((element) => element.textContent?.trim() ?? ""),
        landmarks: elements.filter((element) => ["HEADER", "NAV", "MAIN", "ASIDE", "FOOTER", "FORM"].includes(element.tagName) && visible(element)).map((element) => element.getAttribute("role") ?? element.tagName.toLowerCase()),
        links: [...browserDocument.links].filter(visible).map((element) => ({ text: element.textContent?.trim() ?? "", href: element.href })),
        controls: [...browserDocument.querySelectorAll("input,select,textarea,button")].filter(visible).map((element) => ({ tag: element.tagName.toLowerCase(), name: element.getAttribute("name") ?? "" })),
        readingOrder: elements.filter(visible).map((element) => element.childElementCount === 0 ? element.textContent?.trim() ?? "" : "").filter(Boolean),
        principalBoxes: elements.filter(visible).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = computedStyle(element);
          return { tag: element.tagName.toLowerCase(), id: element.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: style.display, visibility: style.visibility };
        }),
        stylesheets: [...browserDocument.styleSheets].map((sheet) => sheet.href ?? "embedded")
      };
    });
    values.push({ id: fixture.id, inspection });
    await page.close();
  }
  await context.close();
  return values;
};
const scriptingDisabled = await inspect(false);
const scriptingEnabled = process.argv.includes("--classify-script-required") ? await inspect(true) : null;
await browser.close();
const result = {
  schemaVersion: 1,
  chromiumExecutableHash: createHash("sha256").update(await readFile(executablePath)).digest("hex"),
  scriptingDisabled,
  scriptingEnabled
};
const reportPath = resolve("reports/compatibility-chromium.json");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${reportPath}\n`);
