import { type DocumentNodeRef, type IndexedWebDocumentSnapshot } from "../../document/index.js";
import type { ComputedStyle } from "../style/index.js";
import type { GeneratedContentItem } from "../style/generated-content.js";
import { formatCounterNumber } from "./counter-number.js";

interface CounterInstance {
  readonly frame: CounterFrame;
  value: number;
  readonly reversed: boolean;
}
interface CounterFrame { readonly names: Set<string> }
type CounterElementStyle = Pick<ComputedStyle, "display" | "counterReset" | "counterIncrement" | "counterSet">;
export type CounterBudget = "maxCounterOperations" | "maxCounterStates" | "maxTextCodeUnits";

/** One construction-local counter environment. Frames own only counters created at that sibling level. */
export class FormattingCounters {
  readonly #document: IndexedWebDocumentSnapshot;
  readonly #stacks = new Map<string, CounterInstance[]>();
  readonly #frames: CounterFrame[] = [{ names: new Set() }];
  readonly #charge: (budget: CounterBudget, amount?: number) => void;
  readonly #signal: AbortSignal | undefined;

  public constructor(document: IndexedWebDocumentSnapshot, charge: (budget: CounterBudget, amount?: number) => void, signal?: AbortSignal) {
    this.#document = document;
    this.#charge = charge;
    this.#signal = signal;
  }

  public enterChildren(): void { this.#frames.push({ names: new Set() }); }
  public leaveChildren(): void {
    const frame = this.#frames.pop();
    if (frame === undefined) throw new Error("Unbalanced counter scope");
    for (const name of frame.names) {
      const stack = this.#stacks.get(name);
      if (stack?.at(-1)?.frame === frame) { stack.pop(); this.#charge("maxCounterStates", -1); }
      if (stack?.length === 0) this.#stacks.delete(name);
    }
  }

  #step(): void { this.#signal?.throwIfAborted(); this.#charge("maxCounterOperations"); }
  #reset(name: string, value: number, reversed = false): CounterInstance {
    this.#step();
    const frame = this.#frames.at(-1);
    if (frame === undefined) throw new Error("Missing counter scope");
    let stack = this.#stacks.get(name);
    if (stack === undefined) { stack = []; this.#stacks.set(name, stack); }
    if (stack.at(-1)?.frame === frame) stack.pop();
    else this.#charge("maxCounterStates");
    const instance = { frame, value, reversed };
    stack.push(instance);
    frame.names.add(name);
    return instance;
  }
  #counter(name: string): CounterInstance { return this.#stacks.get(name)?.at(-1) ?? this.#reset(name, 0); }
  #increment(name: string, amount: number): void {
    this.#step();
    const counter = this.#counter(name);
    counter.value = Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, counter.value + amount));
  }
  #set(name: string, value: number): void { this.#step(); this.#counter(name).value = value; }

  /** Counter-reset precedes increment, then set, and all precede generated descendants. */
  public apply(style: Pick<ComputedStyle, "counterReset" | "counterIncrement" | "counterSet">): void {
    for (const operation of style.counterReset) this.#reset(operation.name, operation.value, operation.reversed);
    for (const operation of style.counterIncrement) this.#increment(operation.name, operation.value);
    for (const operation of style.counterSet) this.#set(operation.name, operation.value);
  }

  /** HTML list defaults and attributes participate in this same environment. */
  public element(source: DocumentNodeRef, style: CounterElementStyle, participant: (ref: DocumentNodeRef) => CounterElementStyle | null): void {
    const node = this.#document.node(source);
    if (node.kind !== "element" || style.display.box !== "principal") return;
    for (const operation of style.counterReset) {
      let value = operation.value;
      if (operation.auto === true) {
        value = 1;
        const pending = [...node.children];
        while (pending.length > 0) {
          this.#step();
          const child = pending.pop();
          if (child === undefined) continue;
          const childStyle = participant(child);
          if (childStyle === null || childStyle.display.box === "none") continue;
          if (childStyle.display.box === "principal") {
            if (childStyle.counterReset.some((entry) => entry.name === operation.name)) continue;
            if (childStyle.display.listItem) value += 1;
          }
          pending.push(...this.#document.node(child).children);
        }
      }
      this.#reset(operation.name, value, operation.reversed);
    }
    if (style.display.listItem && !style.counterIncrement.some((entry) => entry.name === "list-item")) {
      this.#increment("list-item", this.#counter("list-item").reversed ? -1 : 1);
    }
    for (const operation of style.counterIncrement) this.#increment(operation.name, operation.value);
    for (const operation of style.counterSet) this.#set(operation.name, operation.value);
  }

  public value(name: string): number { this.#step(); return this.#counter(name).value; }

  /** Checks every item and join against the available output budget before materializing it. */
  public text(items: readonly GeneratedContentItem[], source: DocumentNodeRef, maxLength: number): string {
    const pieces: string[] = [];
    let remaining = maxLength;
    const append = (value: string): void => {
      if (value.length > remaining) this.#charge("maxTextCodeUnits", value.length);
      pieces.push(value);
      remaining -= value.length;
    };
    for (const item of items) {
      this.#step();
      if (item.kind === "text") append(item.value);
      else if (item.kind === "attr") append(this.#document.attribute(source, item.name) ?? "");
      else if (item.kind === "counter") append(formatCounterNumber(this.#counter(item.name).value, item.style));
      else {
        this.#counter(item.name);
        const stack = this.#stacks.get(item.name) ?? [];
        for (let index = 0; index < stack.length; index += 1) {
          this.#step();
          if (index > 0) append(item.separator);
          const counter = stack[index];
          if (counter !== undefined) append(formatCounterNumber(counter.value, item.style));
        }
      }
    }
    return pieces.join("");
  }
}
