import type { StyleBudgets } from "./types.js";

const DEFAULT_STYLE_BUDGETS: StyleBudgets = Object.freeze({
  maxStylesheetSources: 64,
  maxStylesheetBytes: 2 * 1024 * 1024,
  maxInlineStylesheetBytes: 512 * 1024,
  // Corrected-meter cold captures: 12.8 MiB descriptor cache maximum;
  // 2.53m construction / 3.70m author evaluation steps maximum. See S2 qualification.
  maxSelectorCacheBytes: 16 * 1024 * 1024,
  maxSelectorConstructionSteps: 4_000_000,
  maxSelectorSteps: 5_000_000,
  maxDiagnostics: 128,
});

/** The compile and evaluation phases share the same validated style limits. */
export function styleBudgets(overrides: Partial<StyleBudgets> | undefined): StyleBudgets {
  const result = { ...DEFAULT_STYLE_BUDGETS, ...overrides };
  for (const name of Object.keys(overrides ?? {})) {
    if (!Object.hasOwn(DEFAULT_STYLE_BUDGETS, name)) throw new TypeError(`Unknown style budget: ${name}`);
  }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return result;
}
