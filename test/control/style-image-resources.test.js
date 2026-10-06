import assert from "node:assert/strict";
import test from "node:test";
import { parseWebDocument, createDocumentState } from "../../dist/document/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, inspectStylesheetText, resolveStyles,
  implementationSupportsCondition, compareStyleSnapshots } from "../../dist/presentation/style/index.js";
import { selectViewportImages } from "../../dist/app/image-admission.js";

const url = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='20'%20height='20'%3E%3Cpath%20d='M0%200h10v10z'/%3E%3C/svg%3E";
const environment = { viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen",
  prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" };
function fixture(html, resources) {
  const document = parseWebDocument(html, { requestUrl: "https://example.test/page", finalUrl: "https://example.test/page" });
  const program = compileStylesheetProgram({ document, resources: resources ?? embeddedStylesheetSources(document) });
  const state = createDocumentState(document);
  const styles = resolveStyles({ program, state, environment });
  return { document, program, state, styles, get: (id) => styles.style(document.elementById(id)) };
}

function reference(fixture, id, pseudo = null) {
  const owner = fixture.document.elementById(id);
  const style = pseudo === null ? fixture.styles.style(owner) : fixture.styles.pseudo(owner, pseudo);
  return { id: style.mask.image.resourceId, requestUrl: style.mask.image.requestUrl, owners: [owner],
    width: null, height: null, hasAlpha: null };
}

test("single percent SVG URL masks survive variables, aliases and computed source identity", () => {
  const f = fixture(`<style>:root{--icon:url("${url}")}#icon{color:#123456;background-color:currentColor;
    -webkit-mask-image:var(--icon);mask-size:20px 20px;mask-position:center;mask-repeat:no-repeat}</style><span id="icon"></span>`);
  const mask = f.get("icon").mask;
  assert.equal(mask.image.kind, "url");
  assert.equal(mask.image.requestUrl, url);
  assert.equal(mask.image.resourceId, url);
  assert.equal(mask.image.sourceUrl, "https://example.test/page#style-0");
  assert.deepEqual(mask.size, { kind: "explicit", width: { kind: "length", value: 20, unit: "px" }, height: { kind: "length", value: 20, unit: "px" } });
  assert.equal(mask.position, "center"); assert.equal(mask.repeat, "no-repeat");
  assert.deepEqual(f.get("icon").text.background, { r: 18, g: 52, b: 86, a: 1 });
  assert.ok(Object.isFrozen(mask));
});

test("stylesheet-relative and document-base mask URLs resolve once at computed style", () => {
  const inspection = inspectStylesheetText('#external{mask-image:url(icons/arrow.svg)}');
  const resource = { ...inspection, sourceKind: "linked", owner: "node-1", requestUrl: "https://cdn.test/css/theme.css",
    finalUrl: "https://cdn.test/v2/theme.css", contentType: "text/css", rootOrder: 0, dependencyOrder: 0,
    importDepth: 0, importedFrom: null, importLayer: null, mediaConditions: [], supportsConditions: [], predeclaredLayers: [] };
  const f = fixture('<base href="https://assets.test/icons/"><span id="external"></span><span id="inline" style="mask-image:url(local.svg)"></span>', [resource]);
  assert.equal(f.get("external").mask.image.requestUrl, "https://cdn.test/v2/icons/arrow.svg");
  assert.equal(f.get("inline").mask.image.requestUrl, "https://assets.test/icons/local.svg");
  const embedded = fixture('<base href="https://assets.test/icons/"><style>#icon{mask-image:url(local.svg)}</style><span id="icon"></span>');
  assert.equal(embedded.get("icon").mask.image.requestUrl, "https://assets.test/icons/local.svg");
});

test("complex masks are explicit unsupported values and supports never claims full mask syntax", () => {
  const f = fixture(`<span id="stack" style="background:black;mask-image:url(a.svg),url(b.svg)"></span>
    <span id="size" style="mask-image:url(a.svg);mask-size:calc(100% + 2)"></span>
    <span id="lum" style="mask-image:url(a.svg);mask-mode:luminance"></span>
    <span id="unsafe" style="mask-image:url(javascript:bad)"></span>
    <span id="none" style="background:black;mask-position:right"></span>`);
  for (const id of ["stack", "lum", "unsafe"]) assert.equal(f.get(id).mask.image.kind, "unsupported", id);
  assert.equal(f.get("size").mask.image.kind, "url", "an invalid dimension sum is ignored without poisoning a valid mask image");
  assert.equal(f.get("size").mask.size.kind, "auto");
  assert.equal(f.get("none").mask.image.kind, "none");
  assert.ok(f.styles.diagnostics.some((entry) => entry.code === "value-unsupported"));
  for (const value of ["(mask-image:url(a.svg),url(b.svg))", "(mask-image:linear-gradient(black,white))",
    "(mask:url(a.svg) center/contain no-repeat)", "(mask-size:calc(100% + 2))", "(mask-mode:luminance)"])
    assert.equal(implementationSupportsCondition(value), false, value);
  assert.equal(implementationSupportsCondition("(-webkit-mask-image:url(a.svg))"), true);
  assert.equal(implementationSupportsCondition("(mask-size:20px 20px)"), true);
  assert.equal(implementationSupportsCondition("(mask-size:calc(100% - 2px))"), true);
});

test("mask sizes reuse the bounded CSS calculation grammar after custom-property substitution", () => {
  const f = fixture('<style>:root{--size:1rem}#icon{mask-image:url(icon.svg);'
    + 'mask-size:calc(max(calc(var(--size) + 4px),10px));mask-position:center;mask-repeat:no-repeat}</style><span id=icon></span>');
  const mask = f.get("icon").mask;
  assert.equal(mask.image.kind, "url");
  assert.equal(mask.image.resourceId, "https://example.test/icon.svg");
  assert.equal(mask.size.kind, "explicit");
  assert.equal(mask.size.width.kind, "calculation");
  assert.equal(mask.size.width.calculation.percentageDependence, "none");
  assert.equal(mask.size.height.kind, "auto");
  assert.equal(mask.position, "center");
  assert.equal(mask.repeat, "no-repeat");
  assert.equal(f.styles.diagnostics.some((entry) => entry.detail.includes("mask-size")), false);
  for (const value of ['calc(max(calc(1rem + 4px),10px))', 'max(calc(0.875rem + 4px),10px)',
    'calc(max(calc(0.875rem - 4px),10px))', 'calc(max(calc(1rem - 4px),10px))',
    'clamp(4px,calc(50% - 2px),30px)', 'calc(2ex + 1ch)']) {
    assert.equal(implementationSupportsCondition(`(mask-size:${value})`), true, value);
  }
});

test("mask is non-inherited, honors resets and has stable pseudo resource ownership", () => {
  const f = fixture(`<style>#parent{mask-image:url(a.svg)}#parent::before{content:"";display:inline-block;mask-image:url(b.svg)}</style>
    <span id="parent"><span id="child"></span><span id="inherit" style="mask-image:inherit"></span><span id="reset" style="mask:none"></span></span>`);
  assert.equal(f.get("child").mask.image.kind, "none");
  assert.equal(f.get("inherit").mask.image.requestUrl, "https://example.test/a.svg");
  assert.equal(f.get("reset").mask.image.kind, "none");
  assert.equal(f.styles.pseudo(f.document.elementById("parent"), "before").mask.image.requestUrl, "https://example.test/b.svg");
});

test("dynamic mask changes invalidate paint and discovery without reusing an old reference", () => {
  const f = fixture('<style>#icon{mask-image:url(a.svg)}#icon:hover{mask-image:url(b.svg)}</style><span id="icon"></span>');
  const state = { ...f.state, hover: f.document.elementById("icon") };
  const changed = resolveStyles({ program: f.program, state, environment });
  assert.equal(changed.style(f.document.elementById("icon")).mask.image.requestUrl, "https://example.test/b.svg");
  assert.deepEqual(compareStyleSnapshots(f.styles, changed), { effectiveChanged: true, reportingChanged: false, backgroundOnly: false });
  assert.notEqual(changed.style(f.document.elementById("icon")).mask.image.resourceId, f.get("icon").mask.image.resourceId);
});

test("CSS masks and img share canonical URL and bounded active resource ownership", () => {
  const f = fixture('<img id="image" src="a.svg"><span id="one" style="mask-image:url(a.svg)"></span><span id="two" style="mask-image:url(b.svg)"></span>');
  const discovered = [reference(f, "one"), reference(f, "two")];
  const first = { id: "https://example.test/a.svg", requestUrl: "https://example.test/a.svg", owners: [f.document.elementById("image")],
    width: 2, height: 2, hasAlpha: true, mimeType: "image/svg+xml", status: "ready", pixels: new Uint8Array(16) };
  const snapshot = { document: f.document, images: [first], imageResourceLimit: 2 };
  const merged = selectViewportImages(snapshot, discovered);
  assert.equal(merged.length, 2); assert.equal(merged[0].pixels, first.pixels);
  assert.ok(merged[0].owners.includes(f.document.elementById("image"))); assert.ok(merged[0].owners.includes(f.document.elementById("one")));
  assert.equal(merged[1].status, "pending"); assert.equal(merged[1].hasAlpha, null);
  assert.equal(selectViewportImages({ ...snapshot, images: merged }, discovered), merged);
  const extra = { ...discovered[0], id: "https://example.test/c.svg", requestUrl: "https://example.test/c.svg" };
  assert.equal(selectViewportImages({ ...snapshot, images: merged }, [...discovered, extra]), merged);
});

test("render worker discovers computed mask references then consumes shared image metadata", async () => {
  const { RenderWorkerClient } = await import("../../dist/ui/render-worker/client.js");
  const { commitNavigation, emptyHistory } = await import("../../dist/app/navigation-history.js");
  const f = fixture(`<style>body{margin:0;background:white}#icon{display:block;width:16px;height:16px;background:currentColor;
    color:#123456;mask-image:url("${url}");mask-size:16px 16px}#icon:hover{mask-image:none}</style><span id="icon"></span><p>Native readable text</p>`);
  const snapshot = { document: f.document, requestUrl: f.document.requestUrl, finalUrl: f.document.finalUrl,
    stylesheets: embeddedStylesheetSources(f.document), styleDiagnostics: [], diagnostics: {}, images: [] };
  let document = { id: "mask-worker", documentRevision: 1, stateRevision: 1, documentState: f.state, snapshot,
    navigation: commitNavigation(emptyHistory(), snapshot, "push", { kind: "direct" }) };
  const parameters = { columns: 40, rows: 10, scrollRow: 0, overscanBefore: 0, overscanAfter: 0, searchQuery: null,
    preferences: { unicode: true, ambiguousWidth: 1, colorDepth: 24, colorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" } };
  const client = new RenderWorkerClient();
  try {
    await client.attach(document);
    const first = await client.renderViewport(document, 1, parameters);
    assert.equal(first.visibleImages.length, 1);
    assert.equal(first.visibleImages[0].requestUrl, url);
    assert.equal("pixels" in first.visibleImages[0], false);
    assert.equal(first.summary.incomplete.some((label) => label.startsWith("artwork.mask-intrinsics-pending")), false,
      "resource acquisition is progress rather than an incomplete-render error");
    document = { ...document, snapshot: { ...snapshot, images: [{ ...first.visibleImages[0], width: 20, height: 20,
      hasAlpha: true, mimeType: "image/svg+xml", status: "ready", pixels: new Uint8Array(1600) }] } };
    assert.equal(await client.updateDocumentImages(document), "paint");
    const second = await client.renderViewport(document, 2, parameters);
    assert.ok(second.cellBuffer.images.some((image) => image.resourceId === url && image.maskTint?.r === 18));
    assert.equal(second.layoutRevision, first.layoutRevision);
    assert.equal(second.summary.incomplete.some((label) => label.startsWith("artwork.mask-intrinsics-pending")), false);
    let viewportRevision = 2;
    for (const dimensions of [{ width: null, height: null }, { width: 20, height: 20 }]) {
      const failed = { ...document, snapshot: { ...document.snapshot, images: [{ ...first.visibleImages[0],
        ...dimensions, hasAlpha: null, status: "failed", failure: "decode-failed", reason: "Controlled failure" }] } };
      assert.equal(await client.updateDocumentImages(failed), "paint");
      const failure = await client.renderViewport(failed, ++viewportRevision, parameters);
      assert.equal(failure.layoutRevision, first.layoutRevision);
      assert.deepEqual(failure.summary.incomplete, ["artwork.mask-resource-failed=1"]);
      assert.equal(failure.visibleImages[0].requestUrl, url, "failed masks retain spatial resource ownership");
      assert.ok(failure.cellBuffer.images.every((image) => image.naturalWidth === dimensions.width && image.naturalHeight === dimensions.height),
        "failed masks preserve their true discovery geometry; pixel readiness remains UI-owned");
      assert.equal(await client.updateDocumentImages(document), "paint");
      const recovered = await client.renderViewport(document, ++viewportRevision, parameters);
      assert.equal(recovered.summary.incomplete.length, 0);
      assert.ok(recovered.cellBuffer.images.some((image) => image.maskTint !== undefined));
    }
    const pixels = document.snapshot.images[0].pixels;
    document = { ...document, stateRevision: 2, documentState: { ...f.state, hover: f.document.elementById("icon") } };
    await client.updateState(document, ["hover"]);
    const third = await client.renderViewport(document, ++viewportRevision, parameters);
    assert.deepEqual(third.visibleImages, []);
    assert.equal(third.cellBuffer.images.length, 0);
    const retained = selectViewportImages(document.snapshot, third.visibleImages);
    assert.deepEqual(retained[0].owners, []);
    assert.equal(retained[0].pixels, pixels);
    assert.equal(retained[0].status, "ready");
    document = { ...document, snapshot: { ...document.snapshot, images: retained } };
    await client.updateDocumentImages(document);
    const fourth = await client.renderViewport(document, ++viewportRevision, parameters);
    assert.equal(fourth.cellBuffer.images.length, 0);
  } finally { await client.close(); }
});


test("mask owner reassignment replaces metadata owners but retains bounded ready pixels", () => {
  const f = fixture('<span id="one" style="mask-image:url(shared.svg)"></span><span id="two"></span>');
  const references = [reference(f, "one")];
  let images = selectViewportImages({ document: f.document, images: [] }, references);
  const pixels = new Uint8Array(16);
  images = [{ ...images[0], status: "ready", width: 2, height: 2, hasAlpha: true, pixels }];
  const moved = selectViewportImages({ document: f.document, images }, [{ ...references[0], owners: [f.document.elementById("two")] }]);
  assert.deepEqual(moved[0].owners, [f.document.elementById("two")]);
  assert.equal(moved[0].pixels, pixels); assert.equal(moved[0].status, "ready");
  const unused = selectViewportImages({ document: f.document, images: moved }, []);
  assert.equal(unused.length, 1); assert.deepEqual(unused[0].owners, []);
  assert.equal(unused[0].pixels, pixels); assert.equal(unused[0].status, "ready");
  assert.equal(selectViewportImages({ document: f.document, images: unused }, []), unused);
});
