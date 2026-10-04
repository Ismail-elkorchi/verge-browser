import { htmlListItemValue, htmlListMetadata, type DocumentNodeRef, type IndexedWebDocumentSnapshot } from "../../document/index.js";
import type { ComponentValue } from "@ismail-elkorchi/css-parser";

/** The supported built-in counter styles; representations never include marker suffixes. */
export type CounterStyle = "none" | "disc" | "circle" | "square" | "decimal"
  | "decimal-leading-zero" | "lower-alpha" | "upper-alpha";

export type GeneratedContentItem =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "attr"; readonly name: string }
  | { readonly kind: "counter"; readonly name: string; readonly style: CounterStyle }
  | { readonly kind: "counters"; readonly name: string; readonly separator: string; readonly style: CounterStyle };

export type GeneratedContentProgram =
  | { readonly kind: "normal" }
  | { readonly kind: "none" }
  | { readonly kind: "items"; readonly visual: readonly GeneratedContentItem[];
      readonly alternative: readonly GeneratedContentItem[] | null };

export interface CounterOperation {
  readonly name: string;
  readonly value: number;
  /** HTML reversed list initialization is counted against the generated box tree. */
  readonly reversed?: boolean;
  readonly auto?: boolean;
}
export const NORMAL_CONTENT: GeneratedContentProgram = Object.freeze({ kind: "normal" });
export const NONE_CONTENT: GeneratedContentProgram = Object.freeze({ kind: "none" });
export const NO_COUNTER_OPERATIONS: readonly CounterOperation[] = Object.freeze([]);
const MAX_VALUE_ITEMS = 1_024;
const RESERVED_NAMES = new Set(["none", "initial", "inherit", "unset", "revert", "revert-layer", "default"]);

function counterName(value: ComponentValue | undefined): string | null {
  return value?.kind === "ident" && !RESERVED_NAMES.has(value.value.toLowerCase()) ? value.value : null;
}

function counterStyle(value: ComponentValue | undefined): CounterStyle | null {
  if (value === undefined) return "decimal";
  if (value.kind !== "ident") return null;
  const name = value.value.toLowerCase();
  if (name === "lower-latin") return "lower-alpha";
  if (name === "upper-latin") return "upper-alpha";
  switch (name) {
    case "none": case "disc": case "circle": case "square": case "decimal":
    case "decimal-leading-zero": case "lower-alpha": case "upper-alpha": return name;
    default: return null;
  }
}

function contentItem(value: ComponentValue): GeneratedContentItem | null {
  if (value.kind === "string") return Object.freeze({ kind: "text", value: value.value });
  if (value.kind !== "function-block" || value.value.length > MAX_VALUE_ITEMS) return null;
  const args = value.value.filter((part) => part.kind !== "whitespace");
  const name = value.name.toLowerCase();
  if (name === "attr") {
    const attribute = args[0];
    return args.length === 1 && attribute?.kind === "ident"
      ? Object.freeze({ kind: "attr", name: attribute.value }) : null;
  }
  const counter = counterName(args[0]);
  if (counter === null) return null;
  if (name === "counter" && (args.length === 1 || (args.length === 3 && args[1]?.kind === "comma"))) {
    const style = counterStyle(args[2]);
    return style === null ? null : Object.freeze({ kind: "counter", name: counter, style });
  }
  if (name === "counters" && args[1]?.kind === "comma" && args[2]?.kind === "string"
    && (args.length === 3 || (args.length === 5 && args[3]?.kind === "comma"))) {
    const style = counterStyle(args[4]);
    return style === null ? null : Object.freeze({ kind: "counters", name: counter, separator: args[2].value, style });
  }
  return null;
}

/** Evaluates resolved parser components directly. Unsupported syntax remains unsupported. */
export function parseContent(values: readonly ComponentValue[]): GeneratedContentProgram | undefined {
  if (values.length > MAX_VALUE_ITEMS * 2) return undefined;
  const significant = values.filter((value) => value.kind !== "whitespace");
  const first = significant[0];
  if (significant.length === 1 && first?.kind === "ident") {
    if (first.value.toLowerCase() === "normal") return NORMAL_CONTENT;
    if (first.value.toLowerCase() === "none") return NONE_CONTENT;
  }
  const visual: GeneratedContentItem[] = [];
  let alternative: GeneratedContentItem[] | null = null;
  for (const value of significant) {
    if (value.kind === "delim" && value.value === 47) {
      if (alternative !== null || visual.length === 0) return undefined;
      alternative = [];
    } else {
      const item = contentItem(value);
      if (item === null) return undefined;
      (alternative ?? visual).push(item);
    }
  }
  if (visual.length === 0 || alternative?.length === 0) return undefined;
  return Object.freeze({ kind: "items", visual: Object.freeze(visual),
    alternative: alternative === null ? null : Object.freeze(alternative) });
}

export function parseCounterOperations(
  values: readonly ComponentValue[], property: "counter-reset" | "counter-increment" | "counter-set"
): readonly CounterOperation[] | undefined {
  if (values.length > MAX_VALUE_ITEMS * 3) return undefined;
  const significant = values.filter((value) => value.kind !== "whitespace");
  if (significant.length === 1 && significant[0]?.kind === "ident"
    && significant[0].value.toLowerCase() === "none") return NO_COUNTER_OPERATIONS;
  if (significant.length === 0) return undefined;
  const operations: CounterOperation[] = [];
  for (let index = 0; index < significant.length; index += 1) {
    const name = counterName(significant[index]);
    if (name === null || operations.length >= MAX_VALUE_ITEMS) return undefined;
    const next = significant[index + 1];
    let value = property === "counter-increment" ? 1 : 0;
    if (next?.kind === "number") {
      if (next.numberType !== "integer" || !Number.isFinite(next.value)) return undefined;
      value = Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, next.value));
      index += 1;
    }
    operations.push(Object.freeze({ name, value }));
  }
  return Object.freeze(operations);
}

export function generatedContentEqual(left: GeneratedContentProgram, right: GeneratedContentProgram): boolean {
  if (left === right) return true;
  if (left.kind !== "items" || right.kind !== "items") return left.kind === right.kind;
  const itemsEqual = (a: readonly GeneratedContentItem[], b: readonly GeneratedContentItem[]): boolean =>
    a.length === b.length && a.every((item, index) => {
      const other = b[index];
      if (item.kind === "text") return other?.kind === "text" && item.value === other.value;
      if (item.kind === "attr") return other?.kind === "attr" && item.name === other.name;
      if (item.kind === "counter") return other?.kind === "counter" && item.name === other.name && item.style === other.style;
      return other?.kind === "counters" && item.name === other.name && item.style === other.style && item.separator === other.separator;
    });
  return itemsEqual(left.visual, right.visual)
    && (left.alternative === null || right.alternative === null ? left.alternative === right.alternative
      : itemsEqual(left.alternative, right.alternative));
}

export function counterOperationsEqual(left: readonly CounterOperation[], right: readonly CounterOperation[]): boolean {
  return left === right || (left.length === right.length
    && left.every((operation, index) => operation.name === right[index]?.name && operation.value === right[index].value
      && Boolean(operation.reversed) === Boolean(right[index].reversed)
      && Boolean(operation.auto) === Boolean(right[index].auto)));
}

/** HTML rendering defaults, below author declarations, keep list numbering in the CSS counter owner. */
export function htmlCounterDefaults(document: IndexedWebDocumentSnapshot, source: DocumentNodeRef): {
  readonly counterReset: readonly CounterOperation[];
  readonly counterSet: readonly CounterOperation[];
} {
  const node = document.node(source);
  let counterReset = NO_COUNTER_OPERATIONS;
  let counterSet = NO_COUNTER_OPERATIONS;
  if (node.kind === "element" && node.namespace === "http://www.w3.org/1999/xhtml") {
    if (node.name === "ol" || node.name === "ul" || node.name === "menu") {
      const list = htmlListMetadata(document, source);
      const reversed = list?.reversed ?? false;
      counterReset = Object.freeze([Object.freeze({ name: "list-item",
        value: (list?.start ?? 1) + (reversed ? 1 : -1), reversed,
        auto: reversed && list?.start === null })]);
    }
    const value = htmlListItemValue(document, source);
    if (value !== null) counterSet = Object.freeze([Object.freeze({ name: "list-item", value })]);
  }
  return { counterReset, counterSet };
}
