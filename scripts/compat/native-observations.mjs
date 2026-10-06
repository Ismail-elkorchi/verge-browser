import { nativeFormObservations } from "./form-observations.mjs";
import { principalRectangle, paintExpectations } from "./run.mjs";

function cssColor(color) {
  if (color === null) return "rgba(0, 0, 0, 0)";
  return color.a === 1 ? `rgb(${color.r}, ${color.g}, ${color.b})` : `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
}

function nativeStyle(style) {
  const fontSize = style.text.fontSize.kind === "zero" ? 0 : style.text.fontSize.value;
  const lineHeight = style.text.lineHeight.kind === "normal" ? "normal"
    : style.text.lineHeight.kind === "number" ? `${style.text.lineHeight.value * fontSize}px`
    : `${style.text.lineHeight.value.kind === "zero" ? 0 : style.text.lineHeight.value.value}px`;
  const display = style.display.box !== "principal" ? style.display.box
    : style.display.internal ?? (style.display.inner === "flow" ? style.display.outer : style.display.inner);
  return { display, overflowX: style.box.overflowX, overflowY: style.box.overflowY, contain: style.box.contain, visibility: style.visibility, fontSize: `${fontSize}px`, lineHeight,
    color: cssColor(style.text.color), backgroundColor: cssColor(style.text.background),
    direction: style.text.direction, whiteSpace: style.text.whiteSpace, fontWeight: String(style.text.fontWeight),
    listStyleType: style.listStyleType, listStylePosition: style.listStylePosition };
}

export function nativeInspection(fixture, variant, snapshot, pipeline) {
  const ids = new Set([...(fixture.oracle?.styles ?? []), ...(fixture.oracle?.geometry ?? [])]
    .flatMap((entry) => entry.referenceId === undefined ? [entry.id] : [entry.id, entry.referenceId]));
  return {
    paintExpectations: paintExpectations(fixture, variant).map((entry) => typeof entry === "string" ? entry : entry.text),
    paintedPhrases: pipeline.evidence.paintedPhrases,
    zeroFontPainted: pipeline.evidence.paintCoverage.zeroFont.painted.length,
    logicalText: pipeline.artifacts.textSearchIndex.text,
    formSemantics: nativeFormObservations(snapshot.document),
    byId: Object.fromEntries([...ids].map((id) => {
      const node = snapshot.document.elementById(id);
      return [id, node === null ? null : { rectangle: principalRectangle(snapshot, pipeline, id), style: nativeStyle(pipeline.artifacts.computedStyles.style(node)) }];
    }))
  };
}

