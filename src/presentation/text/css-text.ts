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
  readonly units: readonly LogicalTextUnit[];
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
      units: Object.freeze([]),
      collapsibleSpacePending,
      outcome: Object.freeze({ status: "rejected", reason: "invalid-budget" })
    });
  }
  const stream = segmentGraphemeClusters(transformed.value, { maxGraphemeClusters: limit }, signal);
  if (stream.outcome.status !== "complete") {
    return Object.freeze({
      transformed,
      units: Object.freeze([]),
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
  const units: LogicalTextUnit[] = [];
  let pending = collapsibleSpacePending;
  for (const cluster of stream.clusters) {
    signal?.throwIfAborted();
    const [contentStartCodeUnit, contentEndCodeUnit] = transformedSourceRange(
      transformed,
      cluster.startCodeUnit,
      cluster.endCodeUnit
    );
    if (cssSegmentBreak(cluster.text) && preservesSegmentBreaks) {
      units.push(Object.freeze({
        kind: "forced-break",
        text: "",
        contentStartCodeUnit,
        contentEndCodeUnit,
        transformedStartCodeUnit: cluster.startCodeUnit,
        transformedEndCodeUnit: cluster.endCodeUnit,
        collapsibleSpace: false
      }));
      pending = false;
      continue;
    }
    if (cluster.text === "\u00ad") {
      units.push(Object.freeze({
        kind: "soft-hyphen",
        text: cluster.text,
        contentStartCodeUnit,
        contentEndCodeUnit,
        transformedStartCodeUnit: cluster.startCodeUnit,
        transformedEndCodeUnit: cluster.endCodeUnit,
        collapsibleSpace: false
      }));
      pending = false;
      continue;
    }
    if (cluster.text === "\t" && !collapses) {
      units.push(Object.freeze({
        kind: "tab",
        text: cluster.text,
        contentStartCodeUnit,
        contentEndCodeUnit,
        transformedStartCodeUnit: cluster.startCodeUnit,
        transformedEndCodeUnit: cluster.endCodeUnit,
        collapsibleSpace: false
      }));
      pending = false;
      continue;
    }
    const collapsible = collapses && cssWhiteSpaceCluster(cluster.text);
    if (collapsible && pending) continue;
    units.push(Object.freeze({
      kind: "text",
      text: collapsible ? " " : cluster.text,
      contentStartCodeUnit,
      contentEndCodeUnit,
      transformedStartCodeUnit: cluster.startCodeUnit,
      transformedEndCodeUnit: cluster.endCodeUnit,
      collapsibleSpace: collapsible
    }));
    pending = collapsible;
  }
  return Object.freeze({
    transformed,
    units: Object.freeze(units),
    collapsibleSpacePending: pending,
    outcome: Object.freeze({ status: "complete", graphemeClusters: stream.clusters.length })
  });
}
