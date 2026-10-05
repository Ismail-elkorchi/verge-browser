import { PackedRows, ValueSequence, checkPackedMetadata } from "../../memory/packed.js";
import { registerRetainedOwner } from "../../memory/retained-cost.js";
import { segmentGraphemeClusters } from "../../unicode/index.js";
import { transformTextWithSourceRanges, transformedSourceRange, type TransformedText } from "./text-transform.js";

export type CssWhiteSpaceMode = "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line" | "break-spaces";
export type CssTextTransform = "none" | "uppercase" | "lowercase" | "capitalize";

export interface LogicalTextUnit {
  readonly kind: "text" | "tab" | "forced-break" | "soft-hyphen";
  readonly text: string;
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
  readonly transformedStartCodeUnit: number;
  readonly transformedEndCodeUnit: number;
  readonly collapsibleSpace: boolean;
}

/** Canonical CSS logical text. Identity offsets are implicit; only transformed exceptions need mapping. */
export class LogicalTextUnits extends ValueSequence<LogicalTextUnit> {
  readonly #rows: PackedRows;
  readonly #transformed: TransformedText;
  public readonly length: number;
  public constructor(transformed: TransformedText, rows: PackedRows) {
    super(); checkPackedMetadata(148, this); this.#transformed = transformed; this.#rows = rows.seal(); this.length = rows.length;
    registerRetainedOwner(this, () => [this.#transformed, this.#rows], () => 32); Object.freeze(this);
  }
  public at(index: number): LogicalTextUnit | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const start = this.#rows.get(index, 0), end = this.#rows.get(index, 1), flags = this.#rows.get(index, 2);
    const [contentStartCodeUnit, contentEndCodeUnit] = transformedSourceRange(this.#transformed, start, end);
    const kind = flags === 2 ? "tab" : flags === 3 ? "forced-break" : flags === 4 ? "soft-hyphen" : "text";
    return { kind, text: kind === "forced-break" ? "" : flags === 1 ? " " : this.#transformed.value.slice(start, end),
      contentStartCodeUnit, contentEndCodeUnit, transformedStartCodeUnit: start, transformedEndCodeUnit: end,
      collapsibleSpace: flags === 1 };
  }
}

export interface CssTextProcessingBudgets {
  readonly maxGraphemeClusters: number;
}

export type CssTextProcessingOutcome =
  | { readonly status: "complete"; readonly graphemeClusters: number }
  | {
      readonly status: "truncated";
      readonly graphemeClusters: number;
      readonly budget: "maxGraphemeClusters";
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-budget" };

export interface ProcessedCssText {
  readonly transformed: TransformedText;
  readonly units: LogicalTextUnits;
  readonly collapsibleSpacePending: boolean;
  readonly outcome: CssTextProcessingOutcome;
}

function cssSpaceCharacter(codePoint: number): boolean {
  return codePoint === 0x0009 || codePoint === 0x000a || codePoint === 0x000c
    || codePoint === 0x000d || codePoint === 0x0020;
}

function cssSegmentBreak(value: string): boolean {
  return value === "\n" || value === "\r" || value === "\r\n";
}

function cssWhiteSpaceCluster(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !cssSpaceCharacter(codePoint)) return false;
  }
  return value.length > 0;
}

/** CSS Text phase-one transformation and white-space processing over UAX #29 clusters. */
export function processCssText(
  value: string,
  transform: CssTextTransform,
  whiteSpace: CssWhiteSpaceMode,
  collapsibleSpacePending = false,
  budgets: Partial<CssTextProcessingBudgets> = {},
  signal?: AbortSignal
): ProcessedCssText {
  const limit = budgets.maxGraphemeClusters ?? 1_000_000;
  const transformed = transformTextWithSourceRanges(value, transform);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    return Object.freeze({
      transformed,
      units: new LogicalTextUnits(transformed, new PackedRows(3)),
      collapsibleSpacePending,
      outcome: Object.freeze({ status: "rejected", reason: "invalid-budget" })
    });
  }
  const stream = segmentGraphemeClusters(transformed.value, { maxGraphemeClusters: limit }, signal);
  if (stream.outcome.status !== "complete") {
    return Object.freeze({
      transformed,
      units: new LogicalTextUnits(transformed, new PackedRows(3)),
      collapsibleSpacePending,
      outcome: stream.outcome.status === "rejected"
        ? Object.freeze({ status: "rejected", reason: "invalid-budget" })
        : Object.freeze({
            status: "truncated",
            graphemeClusters: stream.outcome.clusters,
            budget: "maxGraphemeClusters",
            limit
          })
    });
  }
  const collapses = whiteSpace === "normal" || whiteSpace === "nowrap" || whiteSpace === "pre-line";
  const preservesSegmentBreaks = whiteSpace === "pre" || whiteSpace === "pre-wrap"
    || whiteSpace === "pre-line" || whiteSpace === "break-spaces";
  const units = new PackedRows(3, false, Math.max(1, Math.min(128, stream.clusters.length)));
  let pending = collapsibleSpacePending;
  for (const cluster of stream.clusters) {
    signal?.throwIfAborted();
    if (cssSegmentBreak(cluster.text) && preservesSegmentBreaks) {
      units.push(cluster.startCodeUnit, cluster.endCodeUnit, 3);
      pending = false;
      continue;
    }
    if (cluster.text === "\u00ad") {
      units.push(cluster.startCodeUnit, cluster.endCodeUnit, 4);
      pending = false;
      continue;
    }
    if (cluster.text === "\t" && !collapses) {
      units.push(cluster.startCodeUnit, cluster.endCodeUnit, 2);
      pending = false;
      continue;
    }
    const collapsible = collapses && cssWhiteSpaceCluster(cluster.text);
    if (collapsible && pending) continue;
    units.push(cluster.startCodeUnit, cluster.endCodeUnit, collapsible ? 1 : 0);
    pending = collapsible;
  }
  return Object.freeze({
    transformed,
    units: new LogicalTextUnits(transformed, units),
    collapsibleSpacePending: pending,
    outcome: Object.freeze({ status: "complete", graphemeClusters: stream.clusters.length })
  });
}
