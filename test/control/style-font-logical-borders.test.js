import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { compareStyleSnapshots, compileStylesheetProgram, embeddedStylesheetSources,
  implementationSupportsCondition, resolveStyles } from "../../dist/presentation/style/index.js";

const environment = Object.freeze({ viewportWidthCssPx: 800, viewportHeightCssPx: 600,
  mediaType: "screen", prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine" });
const px = (value) => ({ kind: "length", value, unit: "px" });
function setup(css, body = '<main><p id=t>Text</p></main>') {
  const document = parseWebDocument(`<!doctype html><style>${css}</style>${body}`, {
    requestUrl: "https://font.test/", finalUrl: "https://font.test/",
  });
  const state = createDocumentState(document);
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  const resolve = (next = state, media = environment) => resolveStyles({ program, state: next, environment: media });
  const styles = resolve();
  return { document, state, program, styles, resolve, style: (id = "t") => styles.style(document.elementById(id)) };
}
function font(style) {
  const { fontWeight, fontStyle, fontSize, lineHeight } = style.text;
  return { fontWeight, fontStyle, fontSize, lineHeight };
}
const initialFont = { fontWeight: 400, fontStyle: "normal", fontSize: px(16), lineHeight: { kind: "normal" } };

test("font shorthand uses retained decoded components and resets omitted modeled properties", () => {
  const result = setup(String.raw`main{font:italic bold 30px/3 serif}#t{font:16px/1.6 "A\20 Family",system-ui,sans-serif}`);
  assert.deepEqual(font(result.style()), { ...initialFont, lineHeight: { kind: "number", value: 1.6 } });
  assert.deepEqual(font(setup('#t{font-weight:700;font-style:italic;line-height:3;font:20px serif}').style()), {
    ...initialFont, fontSize: px(20),
  });
  assert.deepEqual(font(setup('#t{font:italic bold 24px/2 serif}').style()), {
    fontWeight: 700, fontStyle: "italic", fontSize: px(24), lineHeight: { kind: "number", value: 2 },
  });
});

test("font longhands and shorthand compete independently by specificity, source order and importance", () => {
  assert.deepEqual(font(setup('#t{font:italic bold 24px/2 serif;font-size:18px;font-style:normal}').style()), {
    fontWeight: 700, fontStyle: "normal", fontSize: px(18), lineHeight: { kind: "number", value: 2 },
  });
  assert.deepEqual(font(setup('#t{font-size:18px!important;font:italic 24px/2 serif}').style()), {
    fontWeight: 400, fontStyle: "italic", fontSize: px(18), lineHeight: { kind: "number", value: 2 },
  });
  assert.equal(setup('#t{font-weight:900}p{font:16px serif}').style().text.fontWeight, 900);
  assert.equal(setup('#t{font:24px serif!important;font-weight:900}').style().text.fontWeight, 400);
});

test("font wide keywords, origin/layer rollback and substituted values retain cascade rules", () => {
  for (const value of ["inherit", "unset"]) {
    const result = setup(`main{font:italic bold 22px/2 serif}#t{font:10px serif;font:${value}}`);
    assert.deepEqual(font(result.style()), { fontWeight: 700, fontStyle: "italic", fontSize: px(22), lineHeight: { kind: "number", value: 2 } });
  }
  assert.deepEqual(font(setup('main{font:italic bold 22px/2 serif}#t{font:initial}').style()), initialFont);
  assert.equal(setup('@layer first,last;@layer first{#t{font:italic bold 20px/2 serif}}@layer last{#t{font:12px serif;font:revert-layer}}').style().text.fontWeight, 700);
  assert.equal(setup('@layer first,last;@layer first{#t{font:italic 20px serif!important}}@layer last{#t{font-weight:900!important}}').style().text.fontWeight, 400);
  assert.deepEqual(font(setup('#t{--font:italic bold 24px/1.5 "Font Name",serif;font:var(--font)}').style()), {
    fontWeight: 700, fontStyle: "italic", fontSize: px(24), lineHeight: { kind: "number", value: 1.5 },
  });
  assert.equal(setup('main{font-weight:300}#t{font-weight:900;font:revert}').style().text.fontWeight, 300);
});

test("unsupported literal font declarations are discarded but invalid substituted winners reset", () => {
  for (const value of ['caption', 'small-caps 20px serif', 'condensed 20px serif', '20px', '20px serif,', '20px inherit']) {
    assert.equal(setup(`#t{font-weight:900;font:${value}}`).style().text.fontWeight, 900, value);
    assert.equal(implementationSupportsCondition(`(font:${value})`), false, value);
  }
  for (const value of ['var(--missing)', 'var(--font)']) {
    const result = setup(`main{font-weight:300}#t{--font:small-caps 20px serif;font-weight:900;font:${value}}`);
    assert.equal(result.style().text.fontWeight, 300, value);
  }
  for (const value of ['16px/1.6 system-ui,sans-serif', 'italic bold 24px/2 "Escaped Family",serif', 'normal normal normal 20px serif']) {
    assert.equal(implementationSupportsCondition(`(font:${value})`), true, value);
  }
  assert.equal(implementationSupportsCondition('(font-family:serif)'), false);
});

test("font size resolves before dependent line-height and records viewport dependencies", () => {
  assert.deepEqual(setup("#t{font:0/1em serif}").style().text.lineHeight, { kind: "length", value: px(0) });
  for (const [height, expected] of [['150%', 30], ['1.5em', 30], ['calc(1em + 10px)', 30]]) {
    assert.deepEqual(setup(`#t{font:20px/${height} serif}`).style().text.lineHeight, { kind: "length", value: px(expected) });
  }
  const result = setup('#t{font:5vw/1.5em serif}');
  assert.deepEqual(result.style().text.fontSize, px(40));
  assert.deepEqual(result.style().text.lineHeight, { kind: "length", value: px(60) });
  assert.equal(result.styles.valueDependencies.computedViewportInlineSize, true);
  const resized = result.resolve(result.state, { ...environment, viewportWidthCssPx: 1000 });
  assert.deepEqual(resized.style(result.document.elementById('t')).text.fontSize, px(50));
});

for (const direction of ['ltr', 'rtl']) {
  test(`logical border candidates map before selecting physical winners (${direction})`, () => {
    const start = direction === 'ltr' ? 'left' : 'right';
    const end = direction === 'ltr' ? 'right' : 'left';
    const result = setup(`#t{direction:${direction};border:1px solid black;border-inline-start:2px solid red;border-${start}-width:4px;border-block:3px solid blue;border-inline-end-style:none}`);
    assert.deepEqual(result.style().box.borderWidths[start], px(4));
    assert.deepEqual(result.style().box.borderWidths[end], px(1));
    assert.deepEqual(result.style().box.borderWidths.top, px(3));
    assert.deepEqual(result.style().box.borderWidths.bottom, px(3));
    assert.equal(result.style().box.borderStyles[start], 'solid');
    assert.equal(result.style().box.borderStyles[end], 'none');
    assert.deepEqual(result.style().box.borderColors[start], { r:255,g:0,b:0,a:1 });
    const reverse = setup(`#t{direction:${direction};border-${start}:5px solid blue;border-inline-start:2px solid red}`).style();
    assert.deepEqual(reverse.box.borderWidths[start], px(2));
    const pairs = setup(`#t{direction:${direction};border-inline-width:2px 4px;border-block-width:3px 5px;border-inline-style:solid none}`).style();
    assert.deepEqual(pairs.box.borderWidths[start], px(2));
    assert.deepEqual(pairs.box.borderWidths[end], px(4));
    assert.deepEqual(pairs.box.borderWidths.top, px(3));
    assert.deepEqual(pairs.box.borderWidths.bottom, px(5));
    assert.equal(pairs.box.borderStyles[end], 'none');
  });
}

test("logical borders preserve layer/importance, rollback, variables and currentcolor", () => {
  const result = setup(`@layer base,theme;@layer base{#t{border-inline-start:2px solid red!important}}@layer theme{#t{border-left:8px solid blue!important}}#t{border-left:12px solid green;color:purple}`);
  assert.deepEqual(result.style().box.borderWidths.left, px(2));
  const rollback = setup('@layer base,theme;@layer base{#t{border-left:3px solid blue}}@layer theme{#t{border-inline-start:2px solid red;border-inline-start:revert-layer}}');
  assert.deepEqual(rollback.style().box.borderWidths.left, px(3));
  const variable = setup('#t{--rail:2px solid currentcolor;color:purple;border-inline-start:var(--rail)}').style();
  assert.deepEqual(variable.box.borderColors.left, variable.text.color);
  assert.equal(implementationSupportsCondition('(border-inline-start:2px solid var(--x))'), false);
  assert.equal(implementationSupportsCondition('(border-inline-start:2px solid red)'), true);
  assert.equal(implementationSupportsCondition('(border-block-color:red blue)'), true);
  assert.equal(implementationSupportsCondition('(border-inline-start:2px dashed red)'), false);
  assert.equal(implementationSupportsCondition('(writing-mode:vertical-rl)'), false);
  assert.deepEqual(setup('#t{border-left:5px solid red;border-inline-start:2px dashed blue}').style().box.borderWidths.left, px(5));
  assert.equal(setup('#t{--bad:2px dashed blue;border-left:5px solid red;border-inline-start:var(--bad)}').style().box.borderStyles.left, 'none');
});

test("direction changes recompute physical logical-border sides and full phase dependencies", () => {
  const result = setup('#t{border-inline-start:2px solid red}#t:target{direction:rtl}');
  const node = result.document.elementById('t');
  const next = result.resolve({ ...result.state, urlTarget: node });
  assert.equal(next.style(node).box.borderStyles.left, 'none');
  assert.equal(next.style(node).box.borderStyles.right, 'solid');
  assert.deepEqual(compareStyleSnapshots(result.styles, next), { effectiveChanged: true, reportingChanged: false, backgroundOnly: false });
  const fonts = setup('#t{font:16px serif}#t:target{font:24px/2 serif}');
  assert.equal(compareStyleSnapshots(fonts.styles, fonts.resolve({ ...fonts.state, urlTarget: fonts.document.elementById('t') })).backgroundOnly, false);
});

test("snapshot equality recognizes private custom-property no-ops and separates reporting changes", () => {
  const result = setup('#t{--rail:2px solid red;border-inline-start:var(--rail)}#t:target{--rail:2px solid red;transform:rotate(1deg)}');
  const next = result.resolve({ ...result.state, urlTarget: result.document.elementById('t') });
  assert.deepEqual(compareStyleSnapshots(result.styles, next), { effectiveChanged: false, reportingChanged: true, backgroundOnly: false });
});

test("logical inherit reads the parent's logical edge across opposite directions", () => {
  const result = setup('main{direction:ltr;border-left:2px solid red;border-right:7px solid blue}#t{direction:rtl;border-inline-start:inherit;border-inline-end-width:inherit}');
  assert.deepEqual(result.style().box.borderWidths.right, px(2));
  assert.deepEqual(result.style().box.borderWidths.left, px(7));
  assert.deepEqual(result.style().box.borderColors.right, { r:255,g:0,b:0,a:1 });
  const physical = setup('main{direction:ltr;border-left:2px solid red;border-right:7px solid blue}#t{direction:rtl;border-right:inherit}');
  assert.deepEqual(physical.style().box.borderWidths.right, px(7));
});


test("relative font weights use the inherited weight for shorthand and longhand", () => {
  // https://www.w3.org/TR/css-fonts-4/#bolderlighter
  for (const [weight, bolder, lighter] of [[1,400,1],[99,400,99],[100,400,100],[349,400,100],
    [350,700,100],[549,700,100],[550,900,400],[749,900,400],[750,900,700],[899,900,700],[900,900,700],[1000,1000,700]]) {
    for (const [relative, expected] of [["bolder",bolder],["lighter",lighter]]) {
      for (const declaration of [`font:${relative} 16px serif`,`font-weight:${relative}`]) {
        const result = setup(`main{font-weight:${weight}}p{${declaration}` + "}");
        assert.equal(result.style().text.fontWeight, expected, `${weight} ${declaration}`);
      }
    }
  }
});
