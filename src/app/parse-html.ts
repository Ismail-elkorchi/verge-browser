import { parse, type DocumentTree, type ParseOptions } from "@ismail-elkorchi/html-parser";

/**
 * Parses an HTML document string with verge-browser's bundled parser dependency.
 *
 * Use this when you need a document tree for low-level helpers such as
 * `renderDocumentToTerminal()` or `extractForms()` without adding a separate
 * `@ismail-elkorchi/html-parser` install to your project.
 *
 * @param html Raw HTML document text.
 * @param options Optional parser configuration for spans, traces, and parse budgets.
 * @returns Parsed document tree compatible with verge-browser rendering and form extraction helpers.
 * @throws {Error} When parse budgets are exceeded or parser options are invalid.
 *
 * @example
 * ```ts
 * import { parseHtml, renderDocumentToTerminal } from "@ismail-elkorchi/verge-browser";
 *
 * const tree = parseHtml("<main><h1>Hello</h1><p>World</p></main>");
 * const rendered = renderDocumentToTerminal({
 *   tree,
 *   requestUrl: "https://example.com",
 *   finalUrl: "https://example.com",
 *   status: 200,
 *   statusText: "OK",
 *   fetchedAtIso: "2026-01-01T00:00:00.000Z",
 *   width: 80
 * });
 *
 * console.log(rendered.lines.length > 0);
 * ```
 */
export function parseHtml(html: string, options: ParseOptions = {}): DocumentTree {
  return parse(html, options);
}
