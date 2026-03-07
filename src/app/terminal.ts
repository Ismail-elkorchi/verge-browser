import type { RenderedLink, RenderedPage } from "./types.js";

const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 30;/**
 * Provides deterministic public behavior for `terminalWidth`.
 */


export function terminalWidth(): number {
  const columns = process.stdout.columns;
  if (!columns || !Number.isFinite(columns)) return DEFAULT_WIDTH;
  return Math.max(40, columns);
}/**
 * Provides deterministic public behavior for `terminalHeight`.
 */


export function terminalHeight(): number {
  const rows = process.stdout.rows;
  if (!rows || !Number.isFinite(rows)) return DEFAULT_HEIGHT;
  return Math.max(10, rows);
}/**
 * Provides deterministic public behavior for `clearTerminal`.
 */


export function clearTerminal(): void {
  process.stdout.write("\u001b[2J\u001b[H");
}/**
 * Formats or resolves deterministic public output for `formatRenderedPage`.
 */


export function formatRenderedPage(page: RenderedPage): string {
  return page.lines.join("\n");
}/**
 * Formats or resolves deterministic public output for `formatLinkTable`.
 */


export function formatLinkTable(links: readonly RenderedLink[]): string {
  if (links.length === 0) {
    return "No links on current page.";
  }

  const lines = ["Links:"];
  for (const link of links) {
    lines.push(`  [${String(link.index)}] ${link.label} -> ${link.resolvedHref}`);
  }
  return lines.join("\n");
}
