import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { buildLayoutFragmentTree, cssCoordinate, cssPixels, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import { terminalCssControlMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

function render(html, images = []) {
  const document = parseWebDocument(`<style>html,body,p,h2{margin:0}</style>${html}`, {
    requestUrl: "https://native-text-layout.test/", finalUrl: "https://native-text-layout.test/"
  });
  const state = createDocumentState(document);
  const styles = resolveStyles({ program: compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) }), state,
    environment: { viewportWidthCssPx: 640, viewportHeightCssPx: 480, mediaType: "screen", prefersColorScheme: "light",
      reducedMotion: false, hover: "hover", pointer: "fine" } });
  const formatting = buildFormattingTree({ document, state, styles, images });
  const rect = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(640), cssPx(480));
  const layout = buildLayoutFragmentTree({ formatting, inlineItemStreams: buildInlineItemStreamSet(formatting),
    context: { viewport: { width: rect.width, height: rect.height }, initialContainingBlock: rect, scrollport: rect,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() } });
  assert.equal(layout.outcome.status, "complete", JSON.stringify(layout.outcome));
  const fragment = (id) => layout.forDocumentNode(document.elementById(id))
    .find((value) => value.kind !== "text" && value.pseudoElement === null && formatting.node(value.formattingNode).appliesBoxStyle);
  const descendants = (id) => {
    const result = [], pending = [typeof id === "string" && !id.startsWith("layout-fragment:") ? fragment(id).id : id];
    while (pending.length) { const value = layout.fragment(pending.pop()); result.push(value); pending.push(...value.children); }
    return result;
  };
  const texts = (id) => descendants(fragment(id).id).filter((value) => value.kind === "text");
  return { document, formatting, layout, fragment, descendants, texts };
}

const longText = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";

for (const direction of ["column", "column-reverse"]) {
  for (const alignment of ["margin:0 auto", "align-self:flex-start", "align-self:center", "align-self:flex-end"]) {
    test(`column fit-content wraps cards with ${direction} and ${alignment}`, () => {
      const result = render(`<div id=card style="display:flex;flex-direction:${direction};width:120px">
        <h2 id=title style="${alignment};max-width:688px;font-size:16px;line-height:16px"><a>${longText}</a></h2>
        <p id=excerpt style="${alignment};max-width:688px;line-height:16px">${longText}</p></div>`);
      for (const id of ["title", "excerpt"]) {
        const child = result.fragment(id);
        assert.equal(cssPixels(child.contentRect.width), 120);
        assert.ok(child.lineBoxes.length > 1);
        assert.equal(child.contentRect.height, child.lineBoxes.reduce((total, line) => total + line.rect.height, 0));
        assert.ok(result.texts(id).every((text) => text.contentRect.x + text.contentRect.width <= child.contentRect.x + child.contentRect.width));
      }
      const title = result.fragment("title"), excerpt = result.fragment("excerpt"), card = result.fragment("card");
      assert.equal(card.contentRect.height, title.marginRect.height + excerpt.marginRect.height);
      assert.equal(direction === "column" ? excerpt.borderRect.y : title.borderRect.y,
        direction === "column" ? title.borderRect.y + title.marginRect.height : excerpt.borderRect.y + excerpt.marginRect.height);
    });
  }
}

test("column fit-content shares percentage bases and constrained width with intrinsic block measurement", () => {
  const result = render(`<div style="display:flex;flex-direction:column;width:200px">
    <section id=item style="align-self:flex-start;margin:0 10%;padding:0 10%;border:2px solid;box-sizing:border-box;min-width:20%;max-width:70%">
      <p id=text>aaaa bbbb cccc dddd</p><div id=percent style="width:50%;height:10px"></div>
    </section><div id=next>x</div></div>`);
  const item = result.fragment("item"), paragraph = result.fragment("text"), percent = result.fragment("percent");
  assert.equal(cssPixels(item.contentRect.width), 96);
  assert.equal(cssPixels(item.borderRect.width), 140);
  assert.equal(cssPixels(item.borderRect.x), 20);
  assert.equal(cssPixels(item.contentRect.x), 42);
  assert.equal(cssPixels(percent.contentRect.width), 48);
  assert.equal(cssPixels(paragraph.contentRect.height), 32);
  assert.equal(cssPixels(item.contentRect.height), 42);
  assert.equal(result.fragment("next").borderRect.y, item.borderRect.y + item.borderRect.height);
});

test("column fit-content respects short content, explicit widths, min/max priority, and real unbreakable overflow", () => {
  const cases = [
    ["hi", "", 16, 16],
    ["alpha bravo", "width:48px", 48, 32],
    ["alpha bravo", "min-width:120px;max-width:80px", 120, 16],
    ["abcdefghijklmnopqrstuvwxy", "", 200, 16],
    ["alpha bravo charlie", "white-space:nowrap", 152, 16],
    ["abcdefghijklmnopqrstuvwxy", "overflow-wrap:anywhere", 80, 48],
  ];
  for (const [text, style, width, height] of cases) {
    const result = render(`<div style="display:flex;flex-direction:column;width:80px;align-items:flex-start"><p id=item style="${style}">${text}</p></div>`);
    assert.equal(cssPixels(result.fragment("item").contentRect.width), width, style + text);
    assert.equal(cssPixels(result.fragment("item").contentRect.height), height, style + text);
  }
});

for (const direction of ["ltr", "rtl"]) {
  for (const flexDirection of ["column", "column-reverse"]) {
    test(`column automatic cross margins obey physical ${direction} ${flexDirection} axes`, () => {
      for (const [margin, expectedX] of [["margin-left:auto", 80], ["margin-right:auto", 0], ["margin:0 auto", 40]]) {
        const result = render(`<div style="display:flex;flex-direction:${flexDirection};direction:${direction};width:120px"><p id=item style="${margin}">short</p></div>`);
        assert.equal(cssPixels(result.fragment("item").contentRect.width), 40);
        assert.equal(cssPixels(result.fragment("item").borderRect.x), expectedX, margin);
      }
    });
  }
}

test("column stretch exclusion and natural replaced ratio agree before and after layout", () => {
  for (const [style, expectedWidth, expectedHeight] of [["margin:0 auto;max-width:100%", 120, 60], ["align-self:flex-start;max-width:100%", 120, 60], ["", 120, 60]]) {
    const result = render(`<div id=flex style="display:flex;flex-direction:column;width:120px"><img id=image src="/natural.png" style="${style}"><p id=after>after</p></div>`,
      [{ id: "https://native-text-layout.test/natural.png", requestUrl: "https://native-text-layout.test/natural.png", owners: [], width: 240, height: 120 }]);
    const image = result.fragment("image");
    assert.equal(cssPixels(image.contentRect.width), expectedWidth, style);
    assert.equal(cssPixels(image.contentRect.height), expectedHeight, style);
    assert.equal(result.fragment("after").borderRect.y, image.borderRect.y + image.borderRect.height);
  }
});

test("nested column intrinsic sizing uses the same cross width as final layout", () => {
  const result = render(`<div style="display:flex;flex-direction:column;width:120px;align-items:flex-start">
    <div id=nested style="display:flex;flex-direction:column;max-width:100%;padding:0 8px;box-sizing:border-box">
      <p id=text style="margin:0 auto">${longText}</p></div><p id=after>after</p></div>`);
  const nested = result.fragment("nested"), text = result.fragment("text");
  assert.equal(cssPixels(nested.borderRect.width), 120);
  assert.equal(cssPixels(text.contentRect.width), 104);
  assert.equal(nested.contentRect.height, text.contentRect.height);
  assert.equal(result.fragment("after").borderRect.y, nested.borderRect.y + nested.borderRect.height);
});

test("text glyph baselines preserve half-leading and each actual vertical alignment", () => {
  const result = render(`<p id=line style="line-height:28px;padding-top:8px"><span id=normal>N</span><span id=compact style="line-height:16px">C</span><span id=tall style="line-height:40px">T</span><span id=up style="vertical-align:8px">U</span><span id=down style="vertical-align:-6px">D</span><span id=top style="vertical-align:top;line-height:16px">A</span><span id=bottom style="vertical-align:bottom;line-height:16px">B</span></p>`);
  const baseline = result.fragment("line").lineBoxes[0].baseline;
  for (const id of ["normal", "compact", "tall"]) {
    const text = result.texts(id)[0];
    assert.equal(text.contentRect.y + text.baseline, baseline, id);
    assert.equal(text.inkRect.y + text.usedFontMetrics.ascent, baseline, id);
    assert.equal(cssPixels(text.inkRect.height), 16);
  }
  assert.equal(result.texts("up")[0].contentRect.y + result.texts("up")[0].baseline, baseline - cssPx(8));
  assert.equal(result.texts("down")[0].contentRect.y + result.texts("down")[0].baseline, baseline + cssPx(6));
  const line = result.fragment("line").lineBoxes[0];
  assert.equal(result.texts("top")[0].contentRect.y, line.rect.y);
  assert.equal(result.texts("bottom")[0].contentRect.y + result.texts("bottom")[0].contentRect.height, line.rect.y + line.rect.height);
  for (const id of ["up", "down", "top", "bottom"]) {
    const text = result.texts(id)[0];
    assert.equal(text.inkRect.y, text.contentRect.y + text.baseline - text.usedFontMetrics.ascent);
  }
});

test("negative half-leading remains real ink overflow through subtree translation", () => {
  const result = render('<div style="padding-top:40px;display:flex;align-items:flex-end;height:80px"><p id=text style="line-height:4px;position:relative;top:7px">ink</p></div>');
  const text = result.texts("text")[0];
  assert.equal(cssPixels(text.contentRect.height), 4);
  assert.equal(cssPixels(text.baseline), 6);
  assert.equal(cssPixels(text.inkRect.y - text.contentRect.y), -6);
  assert.equal(cssPixels(text.inkRect.height), 16);
  assert.ok(text.overflowRect.y <= text.inkRect.y);
  assert.ok(text.overflowRect.y + text.overflowRect.height >= text.inkRect.y + text.inkRect.height);
});

test("native single-line content is centered once with the same intrinsic and final baseline", () => {
  for (const display of ["inline", "block", "flex"]) {
    const result = render(`<div id=parent style="display:${display};align-items:baseline;line-height:28px"><span id=text>text</span><input id=control style="height:40px;padding:4px;border:2px solid;width:80px"></div>`);
    const control = result.fragment("control");
    assert.equal(cssPixels(control.nativeControlPaintRect.height), 16, display);
    assert.equal(cssPixels(control.nativeControlPaintRect.y - control.contentRect.y), 12, display);
    assert.equal(cssPixels(control.nativeControlBaseline), 12, display);
    assert.equal(control.borderRect.y + control.baseline, control.nativeControlPaintRect.y + control.nativeControlBaseline, display);
    if (display !== "block") {
      const text = result.texts("text")[0];
      assert.equal(text.contentRect.y + text.baseline, control.borderRect.y + control.baseline, display);
    }
  }
});

test("multiline native controls retain full content height and explicit fallback line baselines", () => {
  const result = render('<textarea id=area style="height:70px;line-height:28px">first\nsecond</textarea><select id=select multiple style="height:60px"><option>A</option><option>B</option></select>');
  for (const id of ["area", "select"]) {
    const control = result.fragment(id);
    assert.deepEqual(control.nativeControlPaintRect, control.contentRect);
    assert.equal(control.nativeControlBaseline, null);
  }
  const area = result.fragment("area");
  assert.equal(area.controlLines.length, 2);
  assert.deepEqual(area.controlLines.map((line) => [cssPixels(line.blockOffset), cssPixels(line.baseline)]), [[0, 18], [28, 18]]);
});

test("glyph baselines retain super, sub, percentage and middle vertical alignment", () => {
  const result = render('<p id=line style="line-height:28px"><span id=normal>N</span><span id=super style="vertical-align:super;font-size:20px">S</span><span id=sub style="vertical-align:sub;font-size:20px">B</span><span id=percent style="vertical-align:50%;line-height:20px">P</span><span id=middle style="vertical-align:middle;line-height:40px">M</span></p>');
  const baseline = result.fragment("line").lineBoxes[0].baseline;
  for (const [id, shift] of [["normal", 0], ["super", 6.6], ["sub", -4], ["percent", 10]]) {
    const text = result.texts(id)[0];
    assert.equal(text.contentRect.y + text.baseline, baseline - cssPx(shift), id);
  }
  const middle = result.texts("middle")[0];
  assert.equal(middle.contentRect.y + middle.contentRect.height / 2, baseline - cssPx(4));
  assert.equal(middle.inkRect.y + middle.usedFontMetrics.ascent, middle.contentRect.y + middle.baseline);
});

test("anonymous column text does not inherit parent padding during fit-content measurement", () => {
  const result = render(`<div id=outer style="display:flex;flex-direction:column;align-items:flex-start;width:80px;padding:0 14px">${longText}</div>`);
  const texts = result.texts("outer");
  assert.ok(texts.length > 1);
  assert.ok(texts.every((text) => text.contentRect.x >= cssPx(14) && text.contentRect.x + text.contentRect.width <= cssPx(94)));
});

test("stretch width constraints are resolved before forcing a column child", () => {
  for (const [style, width] of [["min-width:120px;max-width:40px", 120], ["max-width:60px;box-sizing:border-box;padding:0 8px;border:2px solid", 40]]) {
    const result = render(`<div style="display:flex;flex-direction:column;width:80px"><p id=item style="${style}">${longText}</p><div id=after>after</div></div>`);
    const item = result.fragment("item");
    assert.equal(cssPixels(item.contentRect.width), width);
    assert.equal(result.fragment("after").borderRect.y, item.borderRect.y + item.borderRect.height);
  }
});
