export const CELL_WIDTH_CSS_PX = 8;
export const ROW_HEIGHT_CSS_PX = 16;
export const DEFAULT_VARIANTS = Object.freeze([
  Object.freeze({ id: "narrow", columns: 40, rows: 120, scrollRow: 0 }),
  Object.freeze({ id: "medium", columns: 80, rows: 90, scrollRow: 0 }),
  Object.freeze({ id: "wide", columns: 120, rows: 70, scrollRow: 0 })
]);
export function fixtureRequestUrl(fixture) {
  return fixture.requestUrl ?? `https://compat.verge.test/${fixture.id}/index.html`;
}
export function fixtureResources(fixture, corpus) {
  return fixture.resources ?? corpus.resourceSets?.[fixture.resourceSet] ?? [];
}
export function mediaEnvironment(variant) {
  return {
    viewportWidthCssPx: variant.columns * CELL_WIDTH_CSS_PX,
    viewportHeightCssPx: variant.rows * ROW_HEIGHT_CSS_PX,
    mediaType: "screen",
    prefersColorScheme: "light",
    reducedMotion: false,
    hover: "hover",
    pointer: "fine"
  };
}
