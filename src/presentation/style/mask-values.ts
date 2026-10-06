import type { ComponentValue } from "@ismail-elkorchi/css-parser";
import { parseCssLength, splitCssComponentValues } from "./css-values.js";
import { sameCssLength } from "./immutable-records.js";
import type { CssMask, CssMaskImage, CssMaskSize } from "./types.js";

/** Single image references only. The shared image pipeline owns bytes and decoding. */
export const MAX_MASK_URL_CODE_UNITS = 256 * 1024;
export const NO_MASK: CssMask = Object.freeze({ image: Object.freeze({ kind: "none" }),
  size: Object.freeze({ kind: "auto" }), position: "top-left", repeat: "repeat" });
export const UNSUPPORTED_MASK_IMAGE: CssMaskImage = Object.freeze({ kind: "unsupported" });
export const MASK_PROPERTIES = new Set(["mask", "mask-image", "mask-size", "mask-position", "mask-repeat",
  "mask-mode", "mask-origin", "mask-clip", "mask-composite", "mask-type"]);

export function maskImageValue(values: readonly ComponentValue[], sourceUrl: string, baseUrl: string): CssMaskImage {
  const parts = values.filter((value) => value.kind !== "whitespace");
  if (parts.length !== 1) return UNSUPPORTED_MASK_IMAGE;
  const part = parts[0];
  if (part?.kind === "ident" && part.value.toLowerCase() === "none") return NO_MASK.image;
  const argument = part?.kind === "function-block" && part.name.toLowerCase() === "url"
    ? part.value.filter((value) => value.kind !== "whitespace") : [];
  const only = argument.length === 1 ? argument[0] : undefined;
  const url = part?.kind === "url" ? part.value : only?.kind === "string" ? only.value : null;
  if (url === null || url.length === 0 || url.length > MAX_MASK_URL_CODE_UNITS) return UNSUPPORTED_MASK_IMAGE;
  try {
    const resolved = new URL(url, baseUrl);
    if (!["http:", "https:", "data:"].includes(resolved.protocol) || resolved.hash.length > 0
      || resolved.username.length > 0 || resolved.password.length > 0) return UNSUPPORTED_MASK_IMAGE;
    const requestUrl = resolved.href;
    if (requestUrl.length > MAX_MASK_URL_CODE_UNITS) return UNSUPPORTED_MASK_IMAGE;
    return Object.freeze({ kind: "url", resourceId: requestUrl, requestUrl, sourceUrl });
  } catch { return UNSUPPORTED_MASK_IMAGE; }
}

export function maskSizeValue(value: string): CssMaskSize | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "auto auto") return NO_MASK.size;
  if (normalized === "contain" || normalized === "cover") return Object.freeze({ kind: normalized });
  const parts = splitCssComponentValues(value, "space");
  if (parts === null || parts.length < 1 || parts.length > 2) return null;
  const width = parseCssLength(parts[0] ?? "", { allowAuto: true });
  const height = parseCssLength(parts[1] ?? "auto", { allowAuto: true });
  // Reuse the general bounded length/calculation grammar. Used percentages and
  // font/viewport units resolve at the canonical layout paint-preparation owner.
  return width !== null && height !== null
    ? Object.freeze({ kind: "explicit", width, height }) : null;
}

export function maskPositionValue(value: string): CssMask["position"] | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  if (["center", "center center", "50%", "50% 50%"].includes(normalized)) return "center";
  if (["left top", "top left", "0 0", "0% 0%", "0px 0px"].includes(normalized)) return "top-left";
  return null;
}
export function maskRepeatValue(value: string): CssMask["repeat"] | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  if (normalized === "no-repeat" || normalized === "no-repeat no-repeat") return "no-repeat";
  if (normalized === "repeat" || normalized === "repeat repeat") return "repeat";
  return null;
}

/** @supports reports the admitted value grammar, never arbitrary mask stacks/effects. */
export function maskPropertySupported(property: string, value: string, components: readonly ComponentValue[]): boolean {
  if (property === "mask-image") return maskImageValue(components, "https://mask.invalid/", "https://mask.invalid/").kind !== "unsupported";
  if (property === "mask-size") return maskSizeValue(value) !== null;
  if (property === "mask-position") return maskPositionValue(value) !== null;
  if (property === "mask-repeat") return maskRepeatValue(value) !== null;
  return property === "mask" && value.trim().toLowerCase() === "none";
}

export function sameCssMask(a: CssMask, b: CssMask): boolean {
  return a === b || (a.image.kind === b.image.kind
    && (a.image.kind !== "url" || (b.image.kind === "url" && a.image.requestUrl === b.image.requestUrl && a.image.sourceUrl === b.image.sourceUrl))
    && a.position === b.position && a.repeat === b.repeat && a.size.kind === b.size.kind
    && (a.size.kind !== "explicit" || (b.size.kind === "explicit"
      && sameCssLength(a.size.width, b.size.width) && sameCssLength(a.size.height, b.size.height))));
}
