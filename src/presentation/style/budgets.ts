import type { StyleBudgets } from "./types.js";

const DEFAULT_STYLE_BUDGETS: StyleBudgets = Object.freeze({
  maxStylesheetSources: 64,
  maxStylesheetBytes: 2 * 1024 * 1024,
  maxInlineStylesheetBytes: 512 * 1024,
  maxSelectorQueries: 4_096,
  maxSelectorSteps: 500_000,
  maxDiagnostics: 128,
});

/** The compile and evaluation phases share the same validated style limits. */
export function styleBudgets(overrides: Partial<StyleBudgets> | undefined): StyleBudgets {
  const result = { ...DEFAULT_STYLE_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return result;
}
