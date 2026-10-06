import { SaxesParser, type SaxesTagNS } from "saxes";
import { ImageResourceError, type ImageHeader } from "./image-header.js";
import type { ImagePolicyOptions } from "./image-policy.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_ELEMENTS = 4096;
const MAX_DEPTH = 32;
const MAX_PATH_CHARACTERS = 192 * 1024;
const MAX_NUMBERS = 32768;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const NUMBER_TOKEN = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/giu;
const PRESENTATION = ["id", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "clip-path", "clip-rule", "transform", "style"];
const ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  svg: ["width", "height", "viewBox", "preserveAspectRatio", "version"],
  title: [], desc: [],
  g: [], defs: [], path: ["d"], rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"], polyline: ["points"], polygon: ["points"],
  clipPath: ["clipPathUnits"],
  linearGradient: ["x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod"],
  radialGradient: ["cx", "cy", "r", "fx", "fy", "fr", "gradientUnits", "gradientTransform", "spreadMethod"],
  stop: ["offset", "stop-color", "stop-opacity"]
};
const ENUMS: Readonly<Record<string, readonly string[]>> = {
  "fill-rule": ["nonzero", "evenodd"], "clip-rule": ["nonzero", "evenodd"],
  "stroke-linecap": ["butt", "round", "square"], "stroke-linejoin": ["miter", "round", "bevel"],
  gradientUnits: ["userSpaceOnUse", "objectBoundingBox"], clipPathUnits: ["userSpaceOnUse", "objectBoundingBox"],
  spreadMethod: ["pad", "reflect", "repeat"], version: ["1.0", "1.1", "2.0"]
};
function unsupported(reason: string): never { throw new ImageResourceError("unsupported-format", `Unsupported static SVG: ${reason}`); }
function malformed(reason: string): never { throw new ImageResourceError("malformed-image", `Malformed SVG: ${reason}`); }
function limit(reason: string): never { throw new ImageResourceError("resource-limit", `SVG exceeds its ${reason} budget.`); }
function isMetadata(name: string | undefined): boolean { return name === "title" || name === "desc"; }
function number(value: string, percentage = false): number {
  const token = percentage && value.endsWith("%") ? value.slice(0, -1) : value;
  if (!NUMBER.test(token)) unsupported("numeric value or unit");
  const result = Number(token);
  if (!Number.isFinite(result) || Math.abs(result) > 1_000_000) limit("coordinate");
  return result;
}
function dimension(value: string): number {
  const result = number(value.endsWith("px") ? value.slice(0, -2) : value);
  if (result <= 0) malformed("non-positive intrinsic dimension");
  return result;
}
function color(value: string): boolean {
  return /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|black|white|red|green|blue|gray|grey|yellow|transparent|none)$/iu.test(value);
}
/** Strict XML and a deliberately small static SVG profile, not an HTML/XML recovery parser.
 * Only plain, inert title/desc metadata may contain text; it never supplies glyphs.
 * No visible text/font, script, animation, filter, image, use, entities, CSS sheet or external resource path.
 * Source/geometry/layer limits bound admitted work; the worker deadline bounds non-cooperative rendering.
 * WASM allocations are not constrained by V8's worker heap limit. */
export function inspectSvgHeader(bytes: Uint8Array, policy: Required<ImagePolicyOptions>): ImageHeader {
  if (bytes.byteLength > MAX_SOURCE_BYTES) limit("source byte");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return malformed("invalid UTF-8"); }
  // Disable all entity references, including internal declarations, before XML parsing.
  if (source.includes("&")) unsupported("entity references");
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  const ids = new Map<string, string>();
  const references: { id: string; kind: "paint" | "clip" }[] = [];
  const state: { root: SaxesTagNS | null } = { root: null };
  let count = 0; let maxDepth = 0; let pathCharacters = 0; let numbers = 0; let gradients = 0; let stops = 0;
  const numericTokens = (value: string): void => {
    for (const match of value.matchAll(NUMBER_TOKEN)) { number(match[0]); if (++numbers > MAX_NUMBERS) limit("numeric token"); }
  };
  parser.on("error", (error) => { malformed(error.message); });
  parser.on("doctype", () => { unsupported("document type declarations"); });
  parser.on("processinginstruction", () => { unsupported("processing instructions"); });
  parser.on("xmldecl", (declaration) => {
    if (declaration.version !== "1.0" || (declaration.encoding !== undefined && declaration.encoding.toLowerCase() !== "utf-8")) unsupported("XML version or encoding");
  });
  parser.on("text", (text) => { if (text.trim().length !== 0 && !isMetadata(stack.at(-1))) unsupported("text content"); });
  parser.on("cdata", () => { unsupported("CDATA content"); });
  parser.on("opentag", (tag) => {
    const name = tag.local;
    if (tag.uri !== SVG_NS || !Object.hasOwn(ATTRIBUTES, name)) unsupported(`element ${tag.name}`);
    if (stack.length === 0) { if (state.root !== null || name !== "svg") malformed("expected one SVG root"); state.root = tag; }
    else if (name === "svg") unsupported("nested SVG viewport");
    const parent = stack.at(-1);
    // Metadata is text-only, even if nested markup would otherwise be admitted.
    // It shares the source, element and depth limits of the surrounding XML tree.
    if (isMetadata(parent)) unsupported("element content inside metadata");
    if (!isMetadata(name) && (parent === "stop" || ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(parent ?? ""))) unsupported("children of a leaf element");
    if (parent === "linearGradient" || parent === "radialGradient") { if (name !== "stop" && !isMetadata(name)) unsupported("gradient child"); }
    else if (name === "stop") unsupported("stop outside a gradient");
    if (++count > MAX_ELEMENTS || stack.length >= MAX_DEPTH) limit("element/depth");
    stack.push(name); maxDepth = Math.max(maxDepth, stack.length);
    if ((name === "linearGradient" || name === "radialGradient") && ++gradients > 128) limit("gradient");
    if (name === "stop" && ++stops > 2048) limit("gradient stop");
    const attributes = Object.values(tag.attributes);
    if (attributes.length > 32) limit("attribute");
    for (const attribute of attributes) {
      const key = attribute.local; const value = attribute.value.trim();
      if (attribute.uri === XMLNS_NS) { if (value !== SVG_NS) unsupported("namespace declaration"); continue; }
      const allowedAttribute = isMetadata(name) ? key === "id" : ATTRIBUTES[name]?.includes(key) === true || PRESENTATION.includes(key);
      if (attribute.uri !== "" || !allowedAttribute) unsupported(`attribute ${attribute.name}`);
      if (key === "id") {
        if (!/^[a-z_][a-z0-9_.-]{0,127}$/iu.test(value) || ids.has(value)) malformed("invalid or duplicate identifier");
        ids.set(value, name);
      } else if (key === "fill" || key === "stroke" || key === "clip-path") {
        if (key === "clip-path" && stack.includes("clipPath")) unsupported("recursive or nested clipping");
        const reference = /^url\(#([a-z_][a-z0-9_.-]{0,127})\)$/iu.exec(value);
        if (reference !== null) references.push({ id: reference[1] ?? "", kind: key === "clip-path" ? "clip" : "paint" });
        else if (key === "clip-path" ? value !== "none" : !color(value)) unsupported("paint or resource reference");
      } else if (key === "stop-color") { if (!color(value) || value === "none") unsupported("gradient color"); }
      else if (key === "style") {
        for (const declaration of value.split(";")) {
          if (declaration.trim() === "") continue;
          const pair = declaration.split(":").map((part) => part.trim());
          if (pair.length !== 2 || !((pair[0] === "isolation" && pair[1] === "isolate") || (pair[0] === "mix-blend-mode" && pair[1] === "multiply"))) unsupported("inline style");
        }
      } else if (key === "d") {
        pathCharacters += attribute.value.length;
        if (pathCharacters > MAX_PATH_CHARACTERS) limit("path character");
        if (!/^[MmZzLlHhVvCcSsQqTtAaEe\d+.,\s-]*$/u.test(value)) malformed("path data");
        numericTokens(value);
      } else if (key === "transform" || key === "gradientTransform") {
        if (!/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([\d+.,\seE-]+\)\s*)+$/u.test(value)) unsupported("transform");
        numericTokens(value);
      } else if (key === "viewBox" || key === "points") {
        if (!/^[\d+.,\seE-]+$/u.test(value)) malformed("numeric list");
        numericTokens(value);
      } else if (key === "preserveAspectRatio") {
        if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/u.test(value)) unsupported("aspect ratio mode");
      } else if (ENUMS[key] !== undefined) { if (!ENUMS[key].includes(value)) unsupported(`${key} value`); }
      else if (key === "width" || key === "height") { dimension(value); }
      else {
        const parsed = number(value, true);
        if ((key.endsWith("opacity") || key === "offset") && (parsed < 0 || parsed > (value.endsWith("%") ? 100 : 1))) malformed("opacity or stop offset");
      }
    }
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.write(source).close();
  if (state.root === null) return malformed("missing root");
  for (const reference of references) {
    const target = ids.get(reference.id);
    if (reference.kind === "clip" ? target !== "clipPath" : target !== "linearGradient" && target !== "radialGradient") unsupported("missing or invalid local reference");
  }
  const attributes: SaxesTagNS["attributes"] = state.root.attributes;
  const viewBox = attributes.viewBox?.value.trim().split(/[\s,]+/u).map(Number);
  if (viewBox !== undefined && (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || (viewBox[2] ?? 0) <= 0 || (viewBox[3] ?? 0) <= 0)) malformed("viewBox dimensions");
  if ((attributes.width === undefined) !== (attributes.height === undefined)) unsupported("partially specified intrinsic dimensions");
  const naturalWidth = attributes.width === undefined ? viewBox?.[2] : dimension(attributes.width.value.trim());
  const naturalHeight = attributes.height === undefined ? viewBox?.[3] : dimension(attributes.height.value.trim());
  if (naturalWidth === undefined || naturalHeight === undefined) unsupported("missing intrinsic dimensions or viewBox");
  const width = Math.max(1, Math.round(naturalWidth)); const height = Math.max(1, Math.round(naturalHeight));
  if (width > policy.maxDimension || height > policy.maxDimension || width * height > policy.maxPixels) {
    throw new ImageResourceError("pixel-limit", "SVG dimensions exceed the pixel budget.");
  }
  // resvg 0.34's renderer bounds each intermediate layer to FOUR TIMES BOTH canvas
  // dimensions, not four times its area. A large off-canvas shape can fill that
  // entire 16x-area allocation at every nested opacity/clip group. Reserve 10 bytes
  // per intermediate pixel (RGBA layer + RGBA clipping surface + alpha mask +
  // padding), as well as the final premultiplied/straight output and transfer copies.
  const surfaceBytes = width * height * (16 + maxDepth * 16 * 10);
  // The renderer converts a referenced clip tree for each use and materializes
  // gradient stops separately for each shape's fill and stroke, including inherited
  // paint. Counting every element/stop for every clip use deliberately overestimates
  // those expansions without depending on renderer optimizations or CSS inheritance.
  const treeInstances = 1 + references.filter((reference) => reference.kind === "clip").length;
  const expandedElements = count * treeInstances;
  const treeBytes = bytes.byteLength * 64 * treeInstances + expandedElements * 1024;
  const gradientBytes = stops * expandedElements * 64;
  // This is conservative admission accounting, not a hard WASM heap cap. Include
  // module/allocator baseline separately; V8 worker heap limits do not bound WASM.
  const workspaceBytes = 16 * 1024 * 1024 + treeBytes + gradientBytes + surfaceBytes;
  if (workspaceBytes > policy.maxWorkspaceBytes) throw new ImageResourceError("workspace-limit", "SVG decode workspace exceeds its budget.");
  return { mimeType: "image/svg+xml", width, height, workspaceBytes };
}
