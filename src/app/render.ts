import {
  findAllByTagName,
  getAttributeValue,
  hasAttribute,
  type DocumentTree,
  type ElementNode,
  type HtmlNode
} from "@ismail-elkorchi/html-parser";
import { measureTextCells, segmentGraphemes } from "@ismail-elkorchi/terminal-ui/text";

import { extractForms, type FormEntry } from "./forms.js";
import { assertAllowedProtocol } from "./security.js";
import {
  resolvePageStyles,
  transformStyledText,
  type ComputedElementStyle,
  type PageStyleResolution
} from "./styles.js";
import { extractCompleteText } from "./text.js";
import { resolveHref } from "./url.js";
import type {
  PageAction,
  PageBlock,
  PageBlockKind,
  PageBlockStyle,
  PageContent,
  PageContentInput,
  PageLayout,
  PageLayoutFragment,
  PageLayoutRow,
  PageLayoutStyleRun,
  PageLinkAction,
  PageRegion,
  PageStyleIssue,
  PageStylesheetResource,
  PageTextRun,
  PageTextStyle,
  RenderInput,
  RenderedActionable,
  RenderedLink,
  RenderedPage
} from "./types.js";

const SKIP_TAGS = new Set(["script", "style", "template", "head"]);
const CONTAINER_TAGS = new Set([
  "address",
  "article",
  "aside",
  "body",
  "div",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "html",
  "main",
  "nav",
  "section"
]);

interface ContentCollector {
  readonly baseUrl: string;
  readonly styles: PageStyleResolution;
  readonly blocks: PageBlock[];
  readonly links: PageLinkAction[];
  readonly actions: PageAction[];
  readonly formsById: ReadonlyMap<string, FormEntry>;
  readonly sourceNodeByBlockId: Map<string, HtmlNode>;
  readonly blockStyleById: Map<string, PageBlockStyle>;
  readonly textRunsByBlockId: Map<string, readonly PageTextRun[]>;
  nextLinkNumber: number;
}

interface PreparedPageContent {
  readonly tree: DocumentTree;
  readonly stylesheets: readonly PageStylesheetResource[];
  readonly stylesheetIssues: readonly PageStyleIssue[];
  readonly authorStyles: "apply" | "ignore";
  readonly sourceNodeByBlockId: ReadonlyMap<string, HtmlNode>;
  readonly blockStyleById: ReadonlyMap<string, PageBlockStyle>;
  readonly textRunsByBlockId: ReadonlyMap<string, readonly PageTextRun[]>;
  readonly styleCache: Map<number, PageStyleResolution>;
  readonly layoutCache: Map<number, PageLayout>;
}

const PREPARED_PAGE_CONTENT = new WeakMap<PageContent, PreparedPageContent>();
const MAX_LAYOUT_CACHE_ENTRIES = 32;

function cachePageValue<T>(cache: Map<number, T>, key: number, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= MAX_LAYOUT_CACHE_ENTRIES) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

interface InlineResult {
  readonly text: string;
  readonly links: readonly Omit<PageLinkAction, "blockId">[];
  readonly textRuns: readonly PageTextRun[];
}

interface WrappedRow {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffsetExclusive: number;
  readonly contentStartCodeUnitIndex: number;
}

interface StyledPageBlock extends PageBlock {
  readonly style: PageBlockStyle;
  readonly textRuns: readonly PageTextRun[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const DEFAULT_TEXT_STYLE: PageTextStyle = Object.freeze({});
const DEFAULT_BLOCK_STYLE = Object.freeze({
  whiteSpace: "normal" as const,
  textAlign: "left" as const,
  marginTopRows: 0,
  marginRightCells: 0,
  marginBottomRows: 0,
  marginLeftCells: 0,
  paddingTopRows: 0,
  paddingRightCells: 0,
  paddingBottomRows: 0,
  paddingLeftCells: 0,
  textIndentCells: 0
});

function elementStyle(node: HtmlNode, collector: ContentCollector): ComputedElementStyle | undefined {
  return node.kind === "element" ? collector.styles.byElement.get(node) : undefined;
}

function imageLabel(node: ElementNode): string | null {
  const alt = getAttributeValue(node, "alt");
  if (alt !== undefined) {
    const normalized = normalizeWhitespace(alt);
    return normalized.length === 0 ? null : normalized;
  }
  const fallback = normalizeWhitespace(
    getAttributeValue(node, "aria-label")
    ?? getAttributeValue(node, "title")
    ?? ""
  );
  return fallback.length === 0 ? "Image" : fallback;
}

function prunesSubtree(node: ElementNode): boolean {
  const ariaHidden = getAttributeValue(node, "aria-hidden")?.trim().toLowerCase();
  return hasAttribute(node, "hidden")
    || ariaHidden === "true"
    || (node.localName.toLowerCase() === "dialog" && !hasAttribute(node, "open"));
}

function pageRegion(node: ElementNode, inherited: PageRegion | undefined): PageRegion | undefined {
  const role = getAttributeValue(node, "role")?.trim().toLowerCase();
  if (
    role === "banner"
    || role === "navigation"
    || role === "main"
    || role === "complementary"
    || role === "contentinfo"
    || role === "search"
  ) {
    return role;
  }
  const tag = node.localName.toLowerCase();
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "aside") return "complementary";
  if (tag === "header" && inherited === undefined) return "banner";
  if (tag === "footer" && inherited === undefined) return "contentinfo";
  return inherited;
}

function navigationAnchors(node: ElementNode): readonly ElementNode[] {
  const anchors: ElementNode[] = [];
  const pending = [...node.children].reverse();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.kind !== "element" || prunesSubtree(current)) continue;
    if (current.localName.toLowerCase() === "a") {
      anchors.push(current);
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      const child = current.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return anchors;
}

function collectNavigation(node: ElementNode, collector: ContentCollector): void {
  const seenTargets = new Set(collector.links.map((link) => link.resolvedHref));
  for (const anchor of navigationAnchors(node)) {
    const href = getAttributeValue(anchor, "href");
    if (!href) continue;
    const target = resolveHref(href, collector.baseUrl);
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);
    const inline = inlineContent([anchor], collector);
    addBlock(collector, anchor, "paragraph", inline.text, {
      region: "navigation",
      textRuns: inline.textRuns,
      links: inline.links
    });
  }
}

function firstTitle(tree: DocumentTree): string {
  for (const titleNode of findAllByTagName(tree, "title")) {
    const title = normalizeWhitespace(extractCompleteText(titleNode));
    if (title.length > 0) return title;
  }
  return "Untitled document";
}

function bodyChildren(tree: DocumentTree): readonly HtmlNode[] {
  for (const body of findAllByTagName(tree, "body")) return body.children;
  return tree.children;
}

/** Returns the effective HTML document base used by links, forms, and stylesheets. */
export function documentBaseUrl(tree: DocumentTree, fallbackUrl: string): string {
  for (const base of findAllByTagName(tree, "base")) {
    const href = getAttributeValue(base, "href");
    if (href === undefined || href.trim().length === 0) continue;
    try {
      const resolved = new URL(href, fallbackUrl);
      assertAllowedProtocol(resolved);
      return resolved.toString();
    } catch {
      continue;
    }
  }
  return fallbackUrl;
}

function blockId(node: HtmlNode, fallback: number): string {
  return node.kind === "element" ? `node:${String(node.id)}` : `text:${String(fallback)}`;
}

function inlineContent(
  nodes: readonly HtmlNode[],
  collector: ContentCollector,
  inheritedStyle?: ComputedElementStyle,
  inheritedElement?: ElementNode
): InlineResult {
  let text = "";
  const links: Omit<PageLinkAction, "blockId">[] = [];
  const textRuns: PageTextRun[] = [];

  const appendRun = (
    fragment: string,
    style: PageTextStyle,
    visible: boolean,
    source?: ElementNode
  ): void => {
    if (fragment.length === 0) return;
    const startCodeUnitIndex = text.length;
    text += fragment;
    textRuns.push({
      startCodeUnitIndex,
      endCodeUnitIndexExclusive: text.length,
      style,
      visible,
      ...(source === undefined ? {} : { sourceElementId: source.id })
    });
  };

  const append = (
    fragment: string,
    style: ComputedElementStyle | undefined,
    source?: ElementNode
  ): void => {
    const transformed = transformStyledText(fragment, style?.textTransform ?? "none");
    const whiteSpace = style?.block.whiteSpace ?? "normal";
    if (whiteSpace === "pre" || whiteSpace === "pre-wrap") {
      appendRun(
        transformed.replace(/\r\n?/gu, "\n"),
        style?.text ?? DEFAULT_TEXT_STYLE,
        style?.visibility !== "hidden",
        source
      );
      return;
    }
    const normalized = whiteSpace === "pre-line"
      ? transformed
        .replace(/\r\n?/gu, "\n")
        .split("\n")
        .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
        .join("\n")
      : transformed.replace(/\s+/gu, " ").trim();
    if (normalized.length === 0) return;
    if (text.length > 0 && !text.endsWith("\n") && !text.endsWith(" ")) {
      appendRun(" ", style?.text ?? DEFAULT_TEXT_STYLE, style?.visibility !== "hidden", source);
    }
    appendRun(normalized, style?.text ?? DEFAULT_TEXT_STYLE, style?.visibility !== "hidden", source);
  };

  const visit = (
    node: HtmlNode,
    parentStyle: ComputedElementStyle | undefined,
    parentElement?: ElementNode
  ): void => {
    if (node.kind === "text") {
      append(node.value, parentStyle, parentElement);
      return;
    }
    if (node.kind !== "element") return;
    const tag = node.localName.toLowerCase();
    if (SKIP_TAGS.has(tag) || prunesSubtree(node)) return;
    const style = elementStyle(node, collector) ?? parentStyle;
    if (tag === "br") {
      text = text.trimEnd();
      if (!text.endsWith("\n")) text += "\n";
      return;
    }
    if (tag === "img") {
      const label = imageLabel(node);
      if (label !== null) append(`▧ ${label}`, style, node);
      return;
    }
    if (tag === "a") {
      const href = getAttributeValue(node, "href");
      if (!href) {
        for (const child of node.children) visit(child, style, node);
        return;
      }
      if (text.length > 0 && !text.endsWith("\n") && !text.endsWith(" ")) {
        appendRun(" ", style?.text ?? DEFAULT_TEXT_STYLE, style?.visibility !== "hidden", node);
      }
      const textOffset = text.length;
      for (const child of node.children) visit(child, style, node);
      if (text.length === textOffset) append(href, style, node);
      const label = text.slice(textOffset);
      if (label.length === 0) return;
      const index = collector.nextLinkNumber;
      collector.nextLinkNumber += 1;
      links.push({
        id: `link:${String(node.id)}`,
        kind: "link",
        index,
        label,
        href,
        resolvedHref: resolveHref(href, collector.baseUrl),
        textOffset
      });
      return;
    }
    if (
      style?.display === "block"
      && text.length > 0
      && !text.endsWith("\n")
    ) {
      appendRun("\n", style.text, style.visibility !== "hidden", node);
    }
    for (const child of node.children) visit(child, style, node);
    if (
      style?.display === "block"
      && text.length > 0
      && !text.endsWith("\n")
    ) {
      appendRun("\n", style.text, style.visibility !== "hidden", node);
    }
  };

  for (const node of nodes) visit(node, inheritedStyle, inheritedElement);
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return {
    text: trimmed,
    links: links.flatMap((link) => {
      const textOffset = link.textOffset - leading;
      return textOffset < 0 || textOffset >= trimmed.length
        ? []
        : [{ ...link, textOffset, label: trimmed.slice(textOffset, textOffset + link.label.length) }];
    }),
    textRuns: textRuns.flatMap((run) => {
      const startCodeUnitIndex = Math.max(0, run.startCodeUnitIndex - leading);
      const endCodeUnitIndexExclusive = Math.min(trimmed.length, run.endCodeUnitIndexExclusive - leading);
      return startCodeUnitIndex >= endCodeUnitIndexExclusive
        ? []
        : [{ ...run, startCodeUnitIndex, endCodeUnitIndexExclusive }];
    })
  };
}

function offsetTextRuns(runs: readonly PageTextRun[], offset: number): readonly PageTextRun[] {
  return runs.map((run) => ({
    ...run,
    startCodeUnitIndex: run.startCodeUnitIndex + offset,
    endCodeUnitIndexExclusive: run.endCodeUnitIndexExclusive + offset
  }));
}

function addBlock(
  collector: ContentCollector,
  node: HtmlNode,
  kind: PageBlockKind,
  rawText: string,
  options: {
    readonly level?: number;
    readonly depth?: number;
    readonly region?: PageRegion;
    readonly links?: InlineResult["links"];
    readonly textRuns?: readonly PageTextRun[];
    readonly computedStyle?: ComputedElementStyle;
  } = {}
): void {
  const text = kind === "preformatted"
    ? rawText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trimEnd()
    : rawText.trim();
  if (text.length === 0) return;
  const id = blockId(node, collector.blocks.length);
  const style = options.computedStyle ?? elementStyle(node, collector);
  const textRuns = options.textRuns ?? [{
    startCodeUnitIndex: 0,
    endCodeUnitIndexExclusive: text.length,
    style: style?.text ?? DEFAULT_TEXT_STYLE,
    visible: style?.visibility !== "hidden",
    ...(node.kind === "element" ? { sourceElementId: node.id } : {})
  }];
  collector.blocks.push({
    id,
    kind,
    text,
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.region === undefined ? {} : { region: options.region })
  });
  collector.sourceNodeByBlockId.set(id, node);
  collector.blockStyleById.set(id, style?.block ?? DEFAULT_BLOCK_STYLE);
  collector.textRunsByBlockId.set(id, textRuns);
  for (const link of options.links ?? []) {
    const action = { ...link, blockId: id };
    collector.links.push(action);
    collector.actions.push(action);
  }
}

function directChildren(node: ElementNode, tag: string): readonly ElementNode[] {
  return node.children.filter(
    (child): child is ElementNode => child.kind === "element" && child.localName.toLowerCase() === tag
  );
}

function collectList(
  node: ElementNode,
  collector: ContentCollector,
  depth: number,
  region: PageRegion | undefined
): void {
  const ordered = node.localName.toLowerCase() === "ol";
  for (const [index, item] of directChildren(node, "li").entries()) {
    const inlineNodes = item.children.filter(
      (child) => child.kind !== "element" || !["ul", "ol"].includes(child.localName.toLowerCase())
    );
    const inline = inlineContent(inlineNodes, collector, elementStyle(item, collector), item);
    const listStyleType = elementStyle(item, collector)?.listStyleType
      ?? (ordered ? "decimal" : "disc");
    const marker = listMarker(listStyleType, index);
    const markerPrefix = marker.length === 0 ? "" : `${marker} `;
    addBlock(collector, item, "listItem", `${markerPrefix}${inline.text}`, {
      depth,
      ...(region === undefined ? {} : { region }),
      textRuns: offsetTextRuns(inline.textRuns, markerPrefix.length),
      links: inline.links.map((link) => ({
        ...link,
        textOffset: link.textOffset + markerPrefix.length
      }))
    });
    for (const child of item.children) {
      if (child.kind === "element" && ["ul", "ol"].includes(child.localName.toLowerCase())) {
        collectList(child, collector, depth + 1, region);
      }
    }
  }
}

function alphabeticMarker(index: number, uppercase: boolean): string {
  let value = index + 1;
  let marker = "";
  while (value > 0) {
    value -= 1;
    marker = String.fromCharCode((uppercase ? 65 : 97) + value % 26) + marker;
    value = Math.floor(value / 26);
  }
  return marker;
}

function listMarker(listStyleType: string, index: number): string {
  switch (listStyleType) {
    case "none": return "";
    case "circle": return "◦";
    case "square": return "▪";
    case "decimal": return `${String(index + 1)}.`;
    case "decimal-leading-zero": return `${String(index + 1).padStart(2, "0")}.`;
    case "lower-alpha": return `${alphabeticMarker(index, false)}.`;
    case "upper-alpha": return `${alphabeticMarker(index, true)}.`;
    default: return "-";
  }
}

function definitionItems(node: ElementNode): readonly ElementNode[] {
  return node.children.flatMap((child) => {
    if (child.kind !== "element") return [];
    const tag = child.localName.toLowerCase();
    if (tag === "dt" || tag === "dd") return [child];
    return tag === "div"
      ? child.children.filter(
          (nested): nested is ElementNode =>
            nested.kind === "element"
            && ["dt", "dd"].includes(nested.localName.toLowerCase())
        )
      : [];
  });
}

function collectDefinitionList(
  node: ElementNode,
  collector: ContentCollector,
  region: PageRegion | undefined
): void {
  for (const item of definitionItems(node)) {
    const inline = inlineContent(item.children, collector, elementStyle(item, collector), item);
    addBlock(
      collector,
      item,
      item.localName.toLowerCase() === "dt" ? "definitionTerm" : "definitionDescription",
      inline.text,
      {
        ...(region === undefined ? {} : { region }),
        textRuns: inline.textRuns,
        links: inline.links
      }
    );
  }
}

function tableRows(node: ElementNode): readonly ElementNode[] {
  const rows: ElementNode[] = [];
  for (const child of node.children) {
    if (child.kind !== "element") continue;
    const tag = child.localName.toLowerCase();
    if (tag === "tr") rows.push(child);
    else if (["thead", "tbody", "tfoot"].includes(tag)) rows.push(...directChildren(child, "tr"));
  }
  return rows;
}

function collectTable(
  node: ElementNode,
  collector: ContentCollector,
  region: PageRegion | undefined
): void {
  for (const [rowIndex, row] of tableRows(node).entries()) {
    const cells = row.children.filter(
      (child): child is ElementNode =>
        child.kind === "element" && ["td", "th"].includes(child.localName.toLowerCase())
    );
    let text = "| ";
    const links: Omit<PageLinkAction, "blockId">[] = [];
    const textRuns: PageTextRun[] = [];
    for (const [cellIndex, cell] of cells.entries()) {
      if (cellIndex > 0) text += " | ";
      const inline = inlineContent(cell.children, collector, elementStyle(cell, collector), cell);
      const cellOffset = text.length;
      text += inline.text;
      textRuns.push(...offsetTextRuns(inline.textRuns, cellOffset));
      links.push(...inline.links.map((link) => ({
        ...link,
        textOffset: cellOffset + link.textOffset
      })));
    }
    text += " |";
    addBlock(collector, row, "tableRow", text, {
      textRuns,
      links,
      ...(region === undefined ? {} : { region })
    });
    if (rowIndex === 0 && cells.some((cell) => cell.localName.toLowerCase() === "th")) {
      collector.blocks.push({
        id: `${blockId(row, rowIndex)}:separator`,
        kind: "tableRow",
        text: `| ${cells.map(() => "────").join(" | ")} |`,
        ...(region === undefined ? {} : { region })
      });
      collector.sourceNodeByBlockId.set(`${blockId(row, rowIndex)}:separator`, row);
      collector.blockStyleById.set(
        `${blockId(row, rowIndex)}:separator`,
        elementStyle(row, collector)?.block ?? DEFAULT_BLOCK_STYLE
      );
      collector.textRunsByBlockId.set(`${blockId(row, rowIndex)}:separator`, []);
    }
  }
}

function collectForm(
  node: ElementNode,
  collector: ContentCollector,
  region: PageRegion | undefined
): void {
  const form = collector.formsById.get(`form:${String(node.id)}`);
  if (!form) return;
  const visibleControls = form.controls.filter((control) => control.kind !== "hidden");
  const radioOptionCounts = new Map<string, number>();
  for (const control of visibleControls) {
    if (control.kind !== "radio") continue;
    const groupName = control.name.length === 0 ? control.id : control.name;
    radioOptionCounts.set(groupName, (radioOptionCounts.get(groupName) ?? 0) + 1);
  }
  const radioGroups = new Set<string>();
  const controlRows: number[] = [];
  for (const control of visibleControls) {
    if (control.kind === "radio") {
      const groupName = control.name.length === 0 ? control.id : control.name;
      if (radioGroups.has(groupName)) continue;
      radioGroups.add(groupName);
      const optionCount = radioOptionCounts.get(groupName) ?? 1;
      controlRows.push(optionCount + 1);
      continue;
    }
    if (control.kind === "text") controlRows.push(2);
    else if (control.kind === "textarea") controlRows.push(3);
    else if (control.kind === "select" && control.multiple) controlRows.push(control.options.length + 1);
    else controlRows.push(1);
  }
  const titleRows = form.label.length === 0 ? 0 : 1;
  const implicitSubmitRows = visibleControls.some((control) => control.kind === "submit") ? 0 : 1;
  const rowCount = Math.max(
    1,
    titleRows
      + controlRows.reduce((sum, rows) => sum + rows, 0)
      + implicitSubmitRows
  );
  const text = Array.from(
    { length: rowCount },
    (_, index) => index === 0
      ? form.label
      : " "
  ).join("\n");
  const block: PageBlock = {
    id: form.id,
    kind: "form",
    text,
    ...(region === undefined ? {} : { region })
  };
  collector.blocks.push(block);
  collector.sourceNodeByBlockId.set(block.id, node);
  collector.blockStyleById.set(
    block.id,
    elementStyle(node, collector)?.block ?? DEFAULT_BLOCK_STYLE
  );
  collector.textRunsByBlockId.set(block.id, [{
    startCodeUnitIndex: 0,
    endCodeUnitIndexExclusive: text.length,
    style: elementStyle(node, collector)?.text ?? DEFAULT_TEXT_STYLE,
    visible: elementStyle(node, collector)?.visibility !== "hidden",
    sourceElementId: node.id
  }]);
  collector.actions.push({
    id: form.id,
    blockId: form.id,
    kind: "form",
    index: form.index,
    label: form.label,
    method: form.method,
    actionUrl: form.actionUrl,
    fieldCount: visibleControls.length,
    textOffset: 0
  });
}

function collectNode(
  node: HtmlNode,
  collector: ContentCollector,
  quoteDepth = 0,
  inheritedRegion?: PageRegion,
  inheritedStyle?: ComputedElementStyle
): void {
  if (node.kind === "text") {
    const text = normalizeWhitespace(transformStyledText(
      node.value,
      inheritedStyle?.textTransform ?? "none"
    ));
    if (text.length > 0) {
      addBlock(collector, node, quoteDepth > 0 ? "quote" : "paragraph", text, {
        depth: quoteDepth,
        ...(inheritedRegion === undefined ? {} : { region: inheritedRegion }),
        ...(inheritedStyle === undefined ? {} : { computedStyle: inheritedStyle })
      });
    }
    return;
  }
  if (node.kind !== "element") return;
  const tag = node.localName.toLowerCase();
  if (SKIP_TAGS.has(tag) || prunesSubtree(node)) return;
  const currentStyle = elementStyle(node, collector) ?? inheritedStyle;
  const region = pageRegion(node, inheritedRegion);
  if (tag === "nav" || (region === "navigation" && inheritedRegion !== "navigation")) {
    collectNavigation(node, collector);
    return;
  }
  if (tag === "details" && !hasAttribute(node, "open")) {
    const summary = node.children.find(
      (child): child is ElementNode =>
        child.kind === "element" && child.localName.toLowerCase() === "summary"
    );
    if (summary !== undefined) collectNode(summary, collector, quoteDepth, region, currentStyle);
    return;
  }
  if (tag === "details") {
    for (const child of node.children) collectNode(child, collector, quoteDepth, region, currentStyle);
    return;
  }
  if (/^h[1-6]$/u.test(tag)) {
    const inline = inlineContent(node.children, collector, elementStyle(node, collector), node);
    addBlock(collector, node, "heading", inline.text, {
      level: Number.parseInt(tag.slice(1), 10),
      ...(region === undefined ? {} : { region }),
      textRuns: inline.textRuns,
      links: inline.links
    });
    return;
  }
  if (tag === "pre") {
    addBlock(collector, node, "preformatted", transformStyledText(
      extractCompleteText(node),
      currentStyle?.textTransform ?? "none"
    ), {
      ...(region === undefined ? {} : { region })
    });
    return;
  }
  if (tag === "img") {
    const label = imageLabel(node);
    if (label !== null) {
      addBlock(collector, node, "image", `▧ ${label}`, {
        ...(region === undefined ? {} : { region })
      });
    }
    return;
  }
  if (tag === "a") {
    const inline = inlineContent([node], collector);
    addBlock(collector, node, quoteDepth > 0 ? "quote" : "paragraph", inline.text, {
      depth: quoteDepth,
      ...(region === undefined ? {} : { region }),
      textRuns: inline.textRuns,
      links: inline.links
    });
    return;
  }
  if (tag === "blockquote") {
    for (const child of node.children) collectNode(child, collector, quoteDepth + 1, region, currentStyle);
    return;
  }
  if (tag === "ul" || tag === "ol") {
    collectList(node, collector, 0, region);
    return;
  }
  if (tag === "dl") {
    collectDefinitionList(node, collector, region);
    return;
  }
  if (tag === "table") {
    collectTable(node, collector, region);
    return;
  }
  if (tag === "form") {
    collectForm(node, collector, region);
    return;
  }
  if (tag === "p" || tag === "li") {
    const inline = inlineContent(node.children, collector, elementStyle(node, collector), node);
    addBlock(collector, node, quoteDepth > 0 ? "quote" : "paragraph", inline.text, {
      depth: quoteDepth,
      ...(region === undefined ? {} : { region }),
      textRuns: inline.textRuns,
      links: inline.links
    });
    return;
  }
  if (CONTAINER_TAGS.has(tag)) {
    for (const child of node.children) collectNode(child, collector, quoteDepth, region, currentStyle);
    return;
  }
  const inline = inlineContent(node.children, collector, elementStyle(node, collector), node);
  addBlock(collector, node, quoteDepth > 0 ? "quote" : "paragraph", inline.text, {
    depth: quoteDepth,
    ...(region === undefined ? {} : { region }),
    textRuns: inline.textRuns,
    links: inline.links
  });
}

/** Builds terminal-independent semantic page content from a parsed document. */
export function buildPageContent(input: PageContentInput): PageContent {
  const baseUrl = documentBaseUrl(input.tree, input.finalUrl);
  let effectiveAuthorStyles = input.authorStyles ?? "apply";
  let styles = resolvePageStyles(
    input.tree,
    input.stylesheets ?? [],
    input.stylesheetIssues ?? [],
    { authorStyles: effectiveAuthorStyles }
  );
  if (
    effectiveAuthorStyles === "apply"
    && styles.issues.some((issue) =>
      issue.code === "stylesheet-limit"
      && issue.message === "Author selector evaluation exceeded the page work budget."
    )
  ) {
    const stylesheetCount = styles.stylesheetCount;
    styles = {
      ...resolvePageStyles(input.tree, [], styles.issues, { authorStyles: "ignore" }),
      stylesheetCount
    };
    effectiveAuthorStyles = "ignore";
  }
  const forms = extractForms(input.tree, baseUrl);
  const collector: ContentCollector = {
    baseUrl,
    styles,
    blocks: [],
    links: [],
    actions: [],
    formsById: new Map(forms.map((form) => [form.id, form])),
    sourceNodeByBlockId: new Map(),
    blockStyleById: new Map(),
    textRunsByBlockId: new Map(),
    nextLinkNumber: 1
  };
  for (const node of bodyChildren(input.tree)) collectNode(node, collector);

  if (collector.blocks.length === 0) {
    const title = firstTitle(input.tree);
    const blocked = input.status === 403 && title.toLowerCase().includes("just a moment");
    if (blocked) {
      collector.blocks.push(
        {
          id: "page:blocked",
          kind: "notice",
          text: "Blocked by anti-bot challenge."
        },
        {
          id: "page:blocked-detail",
          kind: "notice",
          text: "This page requires JavaScript/browser verification and cannot be rendered in CLI mode."
        }
      );
    } else {
      collector.blocks.push({
        id: "page:empty",
        kind: "notice",
        text: "No visible content after script/style filtering."
      });
    }
  }
  if (input.tree.errors.length > 0) {
    collector.blocks.push({
      id: "page:parse-errors",
      kind: "notice",
      text: `Parser reported ${String(input.tree.errors.length)} recoverable issue(s).`
    });
  }

  const content: PageContent = {
    title: firstTitle(input.tree),
    displayUrl: input.finalUrl,
    statusLine: `${String(input.status)} ${input.statusText}`,
    blocks: collector.blocks,
    links: collector.links,
    actions: collector.actions,
    styleIssues: styles.issues,
    stylesheetCount: styles.stylesheetCount,
    parseErrorCount: input.tree.errors.length,
    fetchedAtIso: input.fetchedAtIso
  };
  PREPARED_PAGE_CONTENT.set(content, {
    tree: input.tree,
    stylesheets: input.stylesheets ?? [],
    stylesheetIssues: input.stylesheetIssues ?? [],
    authorStyles: effectiveAuthorStyles,
    sourceNodeByBlockId: collector.sourceNodeByBlockId,
    blockStyleById: collector.blockStyleById,
    textRunsByBlockId: collector.textRunsByBlockId,
    styleCache: new Map([[80, styles]]),
    layoutCache: new Map()
  });
  return content;
}

function prefixForBlock(block: PageBlock): string {
  if (block.kind === "quote") return "│ ".repeat(Math.max(1, block.depth ?? 1));
  if (block.kind === "listItem") return "  ".repeat(block.depth ?? 0);
  if (block.kind === "definitionDescription") return "  ";
  return "";
}

function wrapLine(value: string, width: number): readonly WrappedRow[] {
  if (value.length === 0) {
    return [{ text: "", startOffset: 0, endOffsetExclusive: 0, contentStartCodeUnitIndex: 0 }];
  }
  const graphemes = segmentGraphemes(value);
  const rows: WrappedRow[] = [];
  let startIndex = 0;
  while (startIndex < graphemes.length) {
    let cells = 0;
    let endIndex = startIndex;
    let whitespaceIndex = -1;
    while (endIndex < graphemes.length) {
      const segment = graphemes[endIndex];
      if (!segment) break;
      if (endIndex > startIndex && cells + segment.cells > width) break;
      cells += segment.cells;
      if (/^\s+$/u.test(segment.text)) whitespaceIndex = endIndex;
      endIndex += 1;
      if (cells >= width) break;
    }
    if (endIndex === startIndex) endIndex += 1;
    let contentEndIndex = endIndex;
    let nextStartIndex = endIndex;
    if (endIndex < graphemes.length && whitespaceIndex >= startIndex) {
      contentEndIndex = whitespaceIndex;
      nextStartIndex = whitespaceIndex + 1;
      while (nextStartIndex < graphemes.length && /^\s+$/u.test(graphemes[nextStartIndex]?.text ?? "")) {
        nextStartIndex += 1;
      }
    }
    const startOffset = graphemes[startIndex]?.startOffset ?? value.length;
    const endOffsetExclusive = contentEndIndex >= graphemes.length
      ? value.length
      : graphemes[contentEndIndex]?.startOffset ?? value.length;
    rows.push({
      text: value.slice(startOffset, endOffsetExclusive),
      startOffset,
      endOffsetExclusive,
      contentStartCodeUnitIndex: 0
    });
    startIndex = Math.max(startIndex + 1, nextStartIndex);
  }
  return rows;
}

function wrapExactLine(value: string, width: number): readonly WrappedRow[] {
  if (value.length === 0) {
    return [{ text: "", startOffset: 0, endOffsetExclusive: 0, contentStartCodeUnitIndex: 0 }];
  }
  const graphemes = segmentGraphemes(value);
  const rows: WrappedRow[] = [];
  let startIndex = 0;
  while (startIndex < graphemes.length) {
    let cells = 0;
    let endIndex = startIndex;
    while (endIndex < graphemes.length) {
      const segment = graphemes[endIndex];
      if (!segment) break;
      if (endIndex > startIndex && cells + segment.cells > width) break;
      cells += segment.cells;
      endIndex += 1;
      if (cells >= width) break;
    }
    const startOffset = graphemes[startIndex]?.startOffset ?? value.length;
    const endOffsetExclusive = graphemes[endIndex]?.startOffset ?? value.length;
    rows.push({
      text: value.slice(startOffset, endOffsetExclusive),
      startOffset,
      endOffsetExclusive,
      contentStartCodeUnitIndex: 0
    });
    startIndex = Math.max(startIndex + 1, endIndex);
  }
  return rows;
}

function wrapBlock(block: StyledPageBlock, columns: number): readonly WrappedRow[] {
  const prefix = prefixForBlock(block);
  const prefixCells = measureTextCells(prefix).cells;
  const leftMargin = block.style.marginLeftCells;
  const rightMargin = block.style.marginRightCells;
  const leftPadding = block.style.paddingLeftCells;
  const rightPadding = block.style.paddingRightCells;
  const width = Math.max(
    1,
    columns - leftMargin - rightMargin - prefixCells - leftPadding - rightPadding
  );
  const rows: WrappedRow[] = [];
  let lineOffset = 0;
  for (const [sourceLineIndex, line] of block.text.split("\n").entries()) {
    const indent = sourceLineIndex === 0 ? block.style.textIndentCells : 0;
    const lineWidth = Math.max(1, width - indent);
    const wrapped = block.style.whiteSpace === "nowrap" || block.style.whiteSpace === "pre"
      ? [{ text: line, startOffset: 0, endOffsetExclusive: line.length, contentStartCodeUnitIndex: 0 }]
      : block.style.whiteSpace === "pre-wrap"
        ? wrapExactLine(line, lineWidth)
        : wrapLine(line, lineWidth);
    rows.push(...wrapped.map((row) => ({
      ...row,
      startOffset: lineOffset + row.startOffset,
      endOffsetExclusive: lineOffset + row.endOffsetExclusive
    })));
    lineOffset += line.length + 1;
  }
  return rows.map((row, index) => ({
    ...row,
    text: (() => {
      const leadingPrefix = index === 0 ? prefix : " ".repeat(prefix.length);
      const indent = index === 0 ? block.style.textIndentCells : 0;
      const available = Math.max(
        1,
        columns - leftMargin - rightMargin - prefixCells - leftPadding - rightPadding - indent
      );
      const contentCells = measureTextCells(row.text).cells;
      const alignment = block.style.textAlign === "center"
        ? Math.floor(Math.max(0, available - contentCells) / 2)
        : block.style.textAlign === "right"
          ? Math.max(0, available - contentCells)
          : 0;
      const before = `${" ".repeat(leftMargin)}${leadingPrefix}${" ".repeat(leftPadding + indent + alignment)}`;
      const raw = `${before}${row.text}`;
      return block.style.background === undefined
        ? raw
        : `${raw}${" ".repeat(Math.max(
          0,
          columns - rightMargin - measureTextCells(raw).cells
        ))}`;
    })(),
    contentStartCodeUnitIndex: (() => {
      const indent = index === 0 ? block.style.textIndentCells : 0;
      const available = Math.max(
        1,
        columns - leftMargin - rightMargin - prefixCells - leftPadding - rightPadding - indent
      );
      const contentCells = measureTextCells(row.text).cells;
      const alignment = block.style.textAlign === "center"
        ? Math.floor(Math.max(0, available - contentCells) / 2)
        : block.style.textAlign === "right"
          ? Math.max(0, available - contentCells)
          : 0;
      return leftMargin + prefix.length + leftPadding + indent + alignment;
    })()
  }));
}

/** Returns a readable document width with gutters on ordinary terminals. */
export function documentContentColumns(availableColumns: number): number {
  const columns = Math.max(1, Math.floor(availableColumns));
  return columns < 40 ? columns : Math.min(140, columns - 4);
}

function styleRunsForRow(block: StyledPageBlock, row: WrappedRow): readonly PageLayoutStyleRun[] {
  return block.textRuns.flatMap((run): PageLayoutStyleRun[] => {
    if (!run.visible) return [];
    const overlapStart = Math.max(run.startCodeUnitIndex, row.startOffset);
    const overlapEnd = Math.min(run.endCodeUnitIndexExclusive, row.endOffsetExclusive);
    if (overlapStart >= overlapEnd) return [];
    return [{
      startCodeUnitIndex:
        row.contentStartCodeUnitIndex + overlapStart - row.startOffset,
      endCodeUnitIndexExclusive:
        row.contentStartCodeUnitIndex + overlapEnd - row.startOffset,
      style: run.style
    }];
  });
}

interface RelativeActionPlacement {
  readonly actionId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly width: number;
}

interface RelativeBlockPlacement {
  readonly blockId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly width: number;
  readonly height: number;
}

interface LayoutBox {
  readonly rows: readonly PageLayoutRow[];
  readonly actions: readonly RelativeActionPlacement[];
  readonly blocks: readonly RelativeBlockPlacement[];
  readonly width: number;
  readonly centered: boolean;
}

interface FlowBlock {
  readonly kind: "block";
  readonly block: PageBlock;
  readonly order: number;
}

interface FlowContainer {
  readonly kind: "container";
  readonly element?: ElementNode;
  readonly children: readonly FlowNode[];
  readonly order: number;
}

type FlowNode = FlowBlock | FlowContainer;

interface MutableFlowContainer {
  readonly element?: ElementNode;
  readonly children: (MutableFlowContainer | FlowBlock)[];
  readonly byElement: Map<ElementNode, MutableFlowContainer>;
  order: number;
}

function emptyLayoutRow(width = 0, style: PageTextStyle = {}): PageLayoutRow {
  const text = " ".repeat(Math.max(0, width));
  return {
    text,
    fragments: [],
    styleRuns: text.length === 0 || Object.keys(style).length === 0
      ? []
      : [{ startCodeUnitIndex: 0, endCodeUnitIndexExclusive: text.length, style }]
  };
}

function parentNodes(tree: DocumentTree): ReadonlyMap<HtmlNode, ElementNode | undefined> {
  const parents = new Map<HtmlNode, ElementNode | undefined>();
  const visit = (node: HtmlNode, parent: ElementNode | undefined): void => {
    parents.set(node, parent);
    if (node.kind !== "element" && node.kind !== "templateContent") return;
    const nextParent = node.kind === "element" ? node : parent;
    for (const child of node.children) visit(child, nextParent);
  };
  for (const child of tree.children) visit(child, undefined);
  return parents;
}

function flowTree(content: PageContent, prepared: PreparedPageContent): FlowContainer {
  const parents = parentNodes(prepared.tree);
  const root: MutableFlowContainer = {
    children: [],
    byElement: new Map(),
    order: Number.MAX_SAFE_INTEGER
  };
  for (const [order, block] of content.blocks.entries()) {
    const source = prepared.sourceNodeByBlockId.get(block.id);
    const path: ElementNode[] = [];
    let current = source?.kind === "element" ? parents.get(source) : source === undefined ? undefined : parents.get(source);
    while (current !== undefined) {
      path.push(current);
      current = parents.get(current);
    }
    path.reverse();
    let container = root;
    container.order = Math.min(container.order, order);
    for (const element of path) {
      let child = container.byElement.get(element);
      if (child === undefined) {
        child = {
          element,
          children: [],
          byElement: new Map(),
          order
        };
        container.byElement.set(element, child);
        container.children.push(child);
      }
      child.order = Math.min(child.order, order);
      container = child;
    }
    container.children.push({ kind: "block", block, order });
  }
  const freezeContainer = (container: MutableFlowContainer): FlowContainer => ({
    kind: "container",
    ...(container.element === undefined ? {} : { element: container.element }),
    order: container.order,
    children: container.children
      .sort((left, right) => left.order - right.order)
      .map((child) => "byElement" in child ? freezeContainer(child) : child)
  });
  return freezeContainer(root);
}

function offsetRow(row: PageLayoutRow, prefix: string): PageLayoutRow {
  if (prefix.length === 0) return row;
  const offset = prefix.length;
  return {
    text: `${prefix}${row.text}`,
    fragments: row.fragments.map((fragment) => ({
      ...fragment,
      rowStartCodeUnitIndex: fragment.rowStartCodeUnitIndex + offset,
      rowEndCodeUnitIndexExclusive: fragment.rowEndCodeUnitIndexExclusive + offset
    })),
    styleRuns: row.styleRuns.map((run) => ({
      ...run,
      startCodeUnitIndex: run.startCodeUnitIndex + offset,
      endCodeUnitIndexExclusive: run.endCodeUnitIndexExclusive + offset
    }))
  };
}

function padRow(row: PageLayoutRow, width: number, style: PageTextStyle = {}): PageLayoutRow {
  const cells = measureTextCells(row.text).cells;
  const padding = " ".repeat(Math.max(0, width - cells));
  if (padding.length === 0) return row;
  const start = row.text.length;
  return {
    ...row,
    text: `${row.text}${padding}`,
    styleRuns: Object.keys(style).length === 0
      ? row.styleRuns
      : [
        ...row.styleRuns,
        { startCodeUnitIndex: start, endCodeUnitIndexExclusive: start + padding.length, style }
      ]
  };
}

function overlayRowStyle(row: PageLayoutRow, style: PageTextStyle): PageLayoutRow {
  return row.text.length === 0 || Object.keys(style).length === 0
    ? row
    : {
      ...row,
      styleRuns: [
        { startCodeUnitIndex: 0, endCodeUnitIndexExclusive: row.text.length, style },
        ...row.styleRuns
      ]
    };
}

function leafBox(
  block: PageBlock,
  style: ComputedElementStyle | undefined,
  actions: readonly PageAction[],
  columns: number,
  baseStyle: PageBlockStyle,
  baseTextRuns: readonly PageTextRun[],
  styleByElementId: ReadonlyMap<number, ComputedElementStyle>
): LayoutBox {
  if (style?.display === "none" || style?.box.visuallyHidden) {
    return { rows: [], actions: [], blocks: [], width: 0, centered: false };
  }
  const targetColumns = constrainedWidth(style, columns);
  const textRuns = baseTextRuns.map((run): PageTextRun => {
    const currentStyle = run.sourceElementId === undefined
      ? undefined
      : styleByElementId.get(run.sourceElementId);
    return currentStyle === undefined
      ? run
      : {
        ...run,
        style: currentStyle.text,
        visible: currentStyle.display !== "none"
          && !currentStyle.box.visuallyHidden
          && currentStyle.visibility !== "hidden"
      };
  });
  let visibleText = block.text;
  for (const run of textRuns) {
    if (run.visible) continue;
    visibleText = `${visibleText.slice(0, run.startCodeUnitIndex)}${visibleText
      .slice(run.startCodeUnitIndex, run.endCodeUnitIndexExclusive)
      .replace(/[^\n]/gu, (value) => " ".repeat(value.length))}${visibleText.slice(run.endCodeUnitIndexExclusive)}`;
  }
  const styledBlock: StyledPageBlock = {
    ...block,
    text: visibleText,
    style: style?.block ?? baseStyle,
    textRuns
  };
  const rows: PageLayoutRow[] = [];
  const placements: RelativeActionPlacement[] = [];
  for (let index = 0; index < styledBlock.style.marginTopRows; index += 1) {
    rows.push(emptyLayoutRow());
  }
  for (let index = 0; index < styledBlock.style.paddingTopRows; index += 1) {
    rows.push(emptyLayoutRow(targetColumns, style?.text.background === undefined
      ? {}
      : { background: style.text.background }));
  }
  for (const wrapped of wrapBlock(styledBlock, targetColumns)) {
    const semanticStart = wrapped.contentStartCodeUnitIndex;
    const semanticEnd = semanticStart + wrapped.endOffsetExclusive - wrapped.startOffset;
    const rowIndex = rows.length;
    const baseStyle: PageTextStyle = styledBlock.style.background === undefined
      ? {}
      : { background: styledBlock.style.background };
    const row: PageLayoutRow = {
      text: wrapped.text,
      fragments: [{
        blockId: block.id,
        rowStartCodeUnitIndex: semanticStart,
        rowEndCodeUnitIndexExclusive: semanticEnd,
        blockStartCodeUnitIndex: wrapped.startOffset,
        blockEndCodeUnitIndexExclusive: wrapped.endOffsetExclusive
      }],
      styleRuns: [
        ...(Object.keys(baseStyle).length === 0 || wrapped.text.length === 0
          ? []
          : [{
            startCodeUnitIndex: 0,
            endCodeUnitIndexExclusive: wrapped.text.length,
            style: baseStyle
          }]),
        ...styleRunsForRow(styledBlock, wrapped)
      ]
    };
    rows.push(row);
    for (const action of actions) {
      const overlapStart = Math.max(action.textOffset, wrapped.startOffset);
      const overlapEnd = Math.min(
        action.textOffset + action.label.length,
        wrapped.endOffsetExclusive
      );
      if (overlapStart >= overlapEnd) continue;
      if (!textRuns.some((run) =>
        run.visible
        && run.startCodeUnitIndex < overlapEnd
        && run.endCodeUnitIndexExclusive > overlapStart
      )) {
        continue;
      }
      placements.push({
        actionId: action.id,
        rowIndex,
        columnIndex: measureTextCells(wrapped.text.slice(0, semanticStart)).cells
          + measureTextCells(block.text.slice(wrapped.startOffset, overlapStart)).cells,
        width: Math.max(1, measureTextCells(block.text.slice(overlapStart, overlapEnd)).cells)
      });
    }
  }
  for (let index = 0; index < styledBlock.style.paddingBottomRows; index += 1) {
    rows.push(emptyLayoutRow(targetColumns, style?.text.background === undefined
      ? {}
      : { background: style.text.background }));
  }
  for (let index = 0; index < styledBlock.style.marginBottomRows; index += 1) {
    rows.push(emptyLayoutRow());
  }
  return {
    rows,
    actions: placements,
    blocks: [{
      blockId: block.id,
      rowIndex: styledBlock.style.marginTopRows,
      columnIndex: styledBlock.style.marginLeftCells,
      width: Math.max(1, targetColumns - styledBlock.style.marginLeftCells - styledBlock.style.marginRightCells),
      height: Math.max(0, rows.length - styledBlock.style.marginTopRows - styledBlock.style.marginBottomRows)
    }],
    width: targetColumns,
    centered: style?.box.marginInlineAuto ?? false
  };
}

function cssCells(value: string | undefined, available: number): number | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  const minMatch = /^min\(\s*100%\s*,\s*(.+)\)$/u.exec(normalized);
  if (minMatch?.[1]) return Math.min(available, cssCells(minMatch[1], available) ?? available);
  const match = /^([+]?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|ch|%)$/u.exec(normalized);
  if (!match?.[1] || !match[2]) return null;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return null;
  if (match[2] === "%") return Math.round(available * number / 100);
  if (match[2] === "px") return Math.round(number / 8);
  if (match[2] === "ch") return Math.round(number);
  return Math.round(number * 2);
}

function constrainedWidth(style: ComputedElementStyle | undefined, available: number): number {
  let width = cssCells(style?.box.width, available) ?? available;
  const minimum = cssCells(style?.box.minWidth, available);
  const maximum = cssCells(style?.box.maxWidth, available);
  if (minimum !== null) width = Math.max(width, minimum);
  if (maximum !== null) width = Math.min(width, maximum);
  return Math.max(1, Math.min(available, width));
}

function intrinsicFlowWidth(node: FlowNode): number {
  if (node.kind === "block") {
    return Math.max(1, ...node.block.text.split("\n").map((line) => measureTextCells(line).cells));
  }
  return Math.max(1, ...node.children.map(intrinsicFlowWidth));
}

function gridColumnCount(template: string | undefined, width: number, gap: number): number {
  if (template === undefined) return 1;
  const fixed = /repeat\(\s*(\d+)\s*,/iu.exec(template);
  if (fixed?.[1]) return Math.max(1, Math.min(12, Number.parseInt(fixed[1], 10)));
  if (/repeat\(\s*(?:auto-fit|auto-fill)\s*,/iu.test(template)) {
    const lengths = [...template.matchAll(/(\d+(?:\.\d+)?)(rem|em|ch|px)/giu)]
      .map((match) => cssCells(`${match[1] ?? "0"}${match[2] ?? "px"}`, width) ?? 0);
    const minimum = Math.max(12, ...lengths);
    return Math.max(1, Math.floor((width + gap) / (minimum + gap)));
  }
  let depth = 0;
  let tracks = 0;
  let inTrack = false;
  for (const character of template.trim()) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (/\s/u.test(character) && depth === 0) {
      if (inTrack) tracks += 1;
      inTrack = false;
      continue;
    }
    inTrack = true;
  }
  if (inTrack) tracks += 1;
  return Math.max(1, Math.min(12, tracks));
}

function mergeRows(parts: readonly {
  readonly box: LayoutBox;
  readonly width: number;
  readonly rowOffset: number;
  readonly columnOffset: number;
}[], totalWidth: number): LayoutBox {
  const height = Math.max(0, ...parts.map((part) => part.rowOffset + part.box.rows.length));
  const rows: PageLayoutRow[] = [];
  const actions: RelativeActionPlacement[] = [];
  const blocks: RelativeBlockPlacement[] = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    let text = "";
    const fragments: PageLayoutFragment[] = [];
    const styleRuns: PageLayoutStyleRun[] = [];
    for (const part of parts) {
      if (part.columnOffset > measureTextCells(text).cells) {
        text += " ".repeat(part.columnOffset - measureTextCells(text).cells);
      }
      const localRow = part.box.rows[rowIndex - part.rowOffset] ?? emptyLayoutRow(part.width);
      const padded = padRow(localRow, part.width);
      const codeUnitOffset = text.length;
      text += padded.text;
      fragments.push(...padded.fragments.map((fragment) => ({
        ...fragment,
        rowStartCodeUnitIndex: fragment.rowStartCodeUnitIndex + codeUnitOffset,
        rowEndCodeUnitIndexExclusive: fragment.rowEndCodeUnitIndexExclusive + codeUnitOffset
      })));
      styleRuns.push(...padded.styleRuns.map((run) => ({
        ...run,
        startCodeUnitIndex: run.startCodeUnitIndex + codeUnitOffset,
        endCodeUnitIndexExclusive: run.endCodeUnitIndexExclusive + codeUnitOffset
      })));
    }
    rows.push(padRow({ text, fragments, styleRuns }, totalWidth));
  }
  for (const part of parts) {
    actions.push(...part.box.actions.map((action) => ({
      ...action,
      rowIndex: action.rowIndex + part.rowOffset,
      columnIndex: action.columnIndex + part.columnOffset
    })));
    blocks.push(...part.box.blocks.map((block) => ({
      ...block,
      rowIndex: block.rowIndex + part.rowOffset,
      columnIndex: block.columnIndex + part.columnOffset
    })));
  }
  return { rows, actions, blocks, width: totalWidth, centered: false };
}

function verticalBoxes(boxes: readonly LayoutBox[], width: number, gap: number): LayoutBox {
  const rows: PageLayoutRow[] = [];
  const actions: RelativeActionPlacement[] = [];
  const blocks: RelativeBlockPlacement[] = [];
  const visible = boxes.filter((box) => box.rows.length > 0);
  for (const [index, box] of visible.entries()) {
    if (index > 0) {
      for (let gapIndex = 0; gapIndex < gap; gapIndex += 1) rows.push(emptyLayoutRow());
    }
    const rowOffset = rows.length;
    const columnOffset = box.centered ? Math.max(0, Math.floor((width - box.width) / 2)) : 0;
    rows.push(...box.rows.map((row) => offsetRow(row, " ".repeat(columnOffset))));
    actions.push(...box.actions.map((action) => ({
      ...action,
      rowIndex: action.rowIndex + rowOffset,
      columnIndex: action.columnIndex + columnOffset
    })));
    blocks.push(...box.blocks.map((block) => ({
      ...block,
      rowIndex: block.rowIndex + rowOffset,
      columnIndex: block.columnIndex + columnOffset
    })));
  }
  return { rows, actions, blocks, width, centered: false };
}

function containerStyle(
  box: LayoutBox,
  style: ComputedElementStyle | undefined,
  width: number
): LayoutBox {
  if (style === undefined || style.display === "contents") return box;
  const block = style.block;
  const border = style.box.border;
  const decorates = border
    || block.background !== undefined
    || block.paddingTopRows > 0
    || block.paddingRightCells > 0
    || block.paddingBottomRows > 0
    || block.paddingLeftCells > 0
    || block.marginTopRows > 0
    || block.marginRightCells > 0
    || block.marginBottomRows > 0
    || block.marginLeftCells > 0;
  if (!decorates) {
    return {
      ...box,
      width,
      centered: style.box.marginInlineAuto
    };
  }
  const left = block.paddingLeftCells + block.marginLeftCells + (border ? 1 : 0);
  const right = block.paddingRightCells + block.marginRightCells + (border ? 1 : 0);
  const contentWidth = Math.max(1, width - left - right);
  const backgroundStyle: PageTextStyle = {
    ...(style.text.background === undefined ? {} : { background: style.text.background }),
    ...(style.box.borderColor === undefined ? {} : { foreground: style.box.borderColor })
  };
  const rows: PageLayoutRow[] = [];
  const actions: RelativeActionPlacement[] = [];
  const blocks: RelativeBlockPlacement[] = [];
  for (let index = 0; index < block.marginTopRows; index += 1) rows.push(emptyLayoutRow());
  if (border) {
    rows.push(overlayRowStyle({
      text: `┌${"─".repeat(Math.max(0, width - block.marginLeftCells - block.marginRightCells - 2))}┐`,
      fragments: [],
      styleRuns: []
    }, backgroundStyle));
  }
  for (let index = 0; index < block.paddingTopRows; index += 1) {
    rows.push(overlayRowStyle(emptyLayoutRow(width - block.marginLeftCells - block.marginRightCells), backgroundStyle));
  }
  const contentRowOffset = rows.length;
  for (const row of box.rows) {
    const padded = padRow(row, contentWidth, backgroundStyle);
    const withSides = offsetRow(padded, `${border ? "│" : ""}${" ".repeat(block.paddingLeftCells)}`);
    const suffix = `${" ".repeat(block.paddingRightCells)}${border ? "│" : ""}`;
    rows.push(overlayRowStyle({
      ...withSides,
      text: `${withSides.text}${suffix}`
    }, backgroundStyle));
  }
  actions.push(...box.actions.map((action) => ({
    ...action,
    rowIndex: action.rowIndex + contentRowOffset,
    columnIndex: action.columnIndex + block.paddingLeftCells + (border ? 1 : 0)
  })));
  blocks.push(...box.blocks.map((placement) => ({
    ...placement,
    rowIndex: placement.rowIndex + contentRowOffset,
    columnIndex: placement.columnIndex + block.paddingLeftCells + (border ? 1 : 0)
  })));
  for (let index = 0; index < block.paddingBottomRows; index += 1) {
    rows.push(overlayRowStyle(emptyLayoutRow(width - block.marginLeftCells - block.marginRightCells), backgroundStyle));
  }
  if (border) {
    rows.push(overlayRowStyle({
      text: `└${"─".repeat(Math.max(0, width - block.marginLeftCells - block.marginRightCells - 2))}┘`,
      fragments: [],
      styleRuns: []
    }, backgroundStyle));
  }
  for (let index = 0; index < block.marginBottomRows; index += 1) rows.push(emptyLayoutRow());
  const prefixed = rows.map((row) => offsetRow(row, " ".repeat(block.marginLeftCells)));
  return {
    rows: prefixed,
    actions: actions.map((action) => ({
      ...action,
      columnIndex: action.columnIndex + block.marginLeftCells
    })),
    blocks: blocks.map((placement) => ({
      ...placement,
      columnIndex: placement.columnIndex + block.marginLeftCells
    })),
    width,
    centered: style.box.marginInlineAuto
  };
}

function flowChildren(
  node: FlowContainer,
  styles: PageStyleResolution
): readonly FlowNode[] {
  return node.children.flatMap((child): readonly FlowNode[] => {
    if (child.kind !== "container" || child.element === undefined) return [child];
    return styles.byElement.get(child.element)?.display === "contents"
      ? flowChildren(child, styles)
      : [child];
  });
}

function layoutFlow(
  node: FlowNode,
  width: number,
  styles: PageStyleResolution,
  styleByElementId: ReadonlyMap<number, ComputedElementStyle>,
  actionsByBlock: ReadonlyMap<string, readonly PageAction[]>,
  prepared: PreparedPageContent,
  parents: ReadonlyMap<HtmlNode, ElementNode | undefined>
): LayoutBox {
  if (node.kind === "block") {
    const source = prepared.sourceNodeByBlockId.get(node.block.id);
    const element = source?.kind === "element" ? source : source === undefined ? undefined : parents.get(source);
    return leafBox(
      node.block,
      element === undefined ? undefined : styles.byElement.get(element),
      actionsByBlock.get(node.block.id) ?? [],
      width,
      prepared.blockStyleById.get(node.block.id) ?? DEFAULT_BLOCK_STYLE,
      prepared.textRunsByBlockId.get(node.block.id) ?? [],
      styleByElementId
    );
  }
  const style = node.element === undefined ? undefined : styles.byElement.get(node.element);
  if (style?.display === "none" || style?.box.visuallyHidden) {
    return { rows: [], actions: [], blocks: [], width: 0, centered: false };
  }
  const targetWidth = constrainedWidth(style, width);
  const horizontalOverhead = (style?.block.paddingLeftCells ?? 0)
    + (style?.block.paddingRightCells ?? 0)
    + (style?.box.border ? 2 : 0);
  const innerWidth = Math.max(1, targetWidth - horizontalOverhead);
  const children = flowChildren(node, styles).filter((child) => {
    if (child.kind !== "container" || child.element === undefined) return true;
    const childStyle = styles.byElement.get(child.element);
    return childStyle?.display !== "none" && childStyle?.box.visuallyHidden !== true;
  });
  let body: LayoutBox;
  if (style?.display === "grid" && children.length > 0) {
    const columns = Math.min(
      children.length,
      gridColumnCount(style.box.gridTemplateColumns, innerWidth, style.box.columnGapCells)
    );
    const gap = style.box.columnGapCells;
    const columnWidth = Math.max(1, Math.floor((innerWidth - gap * (columns - 1)) / columns));
    const sortedChildren = [...children].sort((left, right) => {
      const leftColumn = left.kind === "container" && left.element !== undefined
        ? styles.byElement.get(left.element)?.box.gridColumn
        : undefined;
      const rightColumn = right.kind === "container" && right.element !== undefined
        ? styles.byElement.get(right.element)?.box.gridColumn
        : undefined;
      return (leftColumn ?? left.order) - (rightColumn ?? right.order);
    });
    const gridRows: LayoutBox[] = [];
    for (let start = 0; start < sortedChildren.length; start += columns) {
      const rowChildren = sortedChildren.slice(start, start + columns);
      const boxes = rowChildren.map((child) =>
        layoutFlow(child, columnWidth, styles, styleByElementId, actionsByBlock, prepared, parents)
      );
      const maxHeight = Math.max(0, ...boxes.map((box) => box.rows.length));
      gridRows.push(mergeRows(boxes.map((box, index) => ({
        box,
        width: box.centered ? box.width : columnWidth,
        rowOffset: style.box.alignItems === "center"
          ? Math.floor((maxHeight - box.rows.length) / 2)
          : style.box.alignItems === "end"
            ? maxHeight - box.rows.length
            : 0,
        columnOffset: index * (columnWidth + gap)
          + (box.centered ? Math.max(0, Math.floor((columnWidth - box.width) / 2)) : 0)
      })), innerWidth));
    }
    body = verticalBoxes(gridRows, innerWidth, style.box.rowGapRows);
  } else if (style?.display === "flex" && style.box.flexDirection === "row" && children.length > 0) {
    const rows: LayoutBox[] = [];
    let pending: FlowNode[] = [];
    let pendingWidth = 0;
    const flush = (): void => {
      if (pending.length === 0) return;
      const preferred = pending.map((child) =>
        Math.max(1, Math.min(innerWidth, intrinsicFlowWidth(child) + 8))
      );
      const required = preferred.reduce((sum, value) => sum + value, 0)
        + style.box.columnGapCells * Math.max(0, pending.length - 1);
      const spare = Math.max(0, innerWidth - required);
      const leading = style.box.justifyContent === "center"
        ? Math.floor(spare / 2)
        : style.box.justifyContent === "end"
          ? spare
          : 0;
      const between = style.box.justifyContent === "space-between" && pending.length > 1
        ? style.box.columnGapCells + Math.floor(spare / (pending.length - 1))
        : style.box.columnGapCells;
      const boxes = pending.map((child, index) =>
        layoutFlow(
          child,
          preferred[index] ?? 1,
          styles,
          styleByElementId,
          actionsByBlock,
          prepared,
          parents
        )
      );
      const maxHeight = Math.max(0, ...boxes.map((box) => box.rows.length));
      let column = leading;
      const parts = boxes.map((box, index) => {
        const widthForPart = preferred[index] ?? 1;
        const centeredOffset = box.centered
          ? Math.max(0, Math.floor((widthForPart - box.width) / 2))
          : 0;
        const part = {
          box,
          width: box.centered ? box.width : widthForPart,
          rowOffset: style.box.alignItems === "center"
            ? Math.floor((maxHeight - box.rows.length) / 2)
            : style.box.alignItems === "end"
              ? maxHeight - box.rows.length
              : 0,
          columnOffset: column + centeredOffset
        };
        column += widthForPart + between;
        return part;
      });
      rows.push(mergeRows(parts, innerWidth));
      pending = [];
      pendingWidth = 0;
    };
    for (const child of children) {
      const preferred = Math.max(1, Math.min(innerWidth, intrinsicFlowWidth(child) + 8));
      const nextWidth = pendingWidth
        + (pending.length === 0 ? 0 : style.box.columnGapCells)
        + preferred;
      if (style.box.flexWrap && pending.length > 0 && nextWidth > innerWidth) flush();
      pending.push(child);
      pendingWidth += (pending.length === 1 ? 0 : style.box.columnGapCells) + preferred;
    }
    flush();
    body = verticalBoxes(rows, innerWidth, style.box.rowGapRows);
  } else {
    const childBoxes = children.map((child) =>
      layoutFlow(child, innerWidth, styles, styleByElementId, actionsByBlock, prepared, parents)
    );
    body = verticalBoxes(childBoxes, innerWidth, style?.box.rowGapRows ?? 1);
  }
  if (style !== undefined && body.rows.length < style.box.minHeightRows) {
    const missing = style.box.minHeightRows - body.rows.length;
    const before = style.box.alignItems === "center" ? Math.floor(missing / 2) : 0;
    const after = missing - before;
    body = {
      ...body,
      rows: [
        ...Array.from({ length: before }, () => emptyLayoutRow(innerWidth)),
        ...body.rows,
        ...Array.from({ length: after }, () => emptyLayoutRow(innerWidth))
      ],
      actions: body.actions.map((action) => ({ ...action, rowIndex: action.rowIndex + before })),
      blocks: body.blocks.map((block) => ({ ...block, rowIndex: block.rowIndex + before }))
    };
  }
  return containerStyle(body, style, targetWidth);
}

function actionsByBlock(content: PageContent): ReadonlyMap<string, readonly PageAction[]> {
  const result = new Map<string, PageAction[]>();
  for (const action of content.actions) {
    const blockActions = result.get(action.blockId) ?? [];
    blockActions.push(action);
    result.set(action.blockId, blockActions);
  }
  return result;
}

function layoutUnpreparedContent(content: PageContent, columns: number): PageLayout {
  const actionMap = actionsByBlock(content);
  const boxes = content.blocks.map((block) => leafBox(
    block,
    undefined,
    actionMap.get(block.id) ?? [],
    columns,
    DEFAULT_BLOCK_STYLE,
    [{
      startCodeUnitIndex: 0,
      endCodeUnitIndexExclusive: block.text.length,
      style: DEFAULT_TEXT_STYLE,
      visible: true
    }],
    new Map()
  ));
  const box = verticalBoxes(boxes, columns, 1);
  return {
    columns,
    rows: box.rows,
    actionPlacements: box.actions,
    blockPlacements: box.blocks,
    canvasStyle: {},
    styleIssues: content.styleIssues
  };
}

/** Derives terminal rows and action geometry from semantic page content. */
export function layoutPageContent(content: PageContent, columns: number): PageLayout {
  const normalizedColumns = Math.max(1, Math.floor(columns));
  const prepared = PREPARED_PAGE_CONTENT.get(content);
  if (prepared === undefined) return layoutUnpreparedContent(content, normalizedColumns);
  const cached = prepared.layoutCache.get(normalizedColumns);
  if (cached !== undefined) return cached;
  let styles = prepared.styleCache.get(normalizedColumns);
  if (styles === undefined) {
    styles = resolvePageStyles(
      prepared.tree,
      prepared.stylesheets,
      prepared.stylesheetIssues,
      { authorStyles: prepared.authorStyles, columns: normalizedColumns }
    );
    cachePageValue(prepared.styleCache, normalizedColumns, styles);
  }
  const actionMap = actionsByBlock(content);
  const parents = parentNodes(prepared.tree);
  const styleByElementId = new Map<number, ComputedElementStyle>();
  for (const [element, elementStyle] of styles.byElement) {
    styleByElementId.set(element.id, elementStyle);
  }
  const box = layoutFlow(
    flowTree(content, prepared),
    normalizedColumns,
    styles,
    styleByElementId,
    actionMap,
    prepared,
    parents
  );
  const body = [...findAllByTagName(prepared.tree, "body")][0];
  const bodyStyle = body === undefined ? undefined : styles.byElement.get(body);
  const layout: PageLayout = {
    columns: normalizedColumns,
    rows: box.rows,
    actionPlacements: box.actions.map((action) => ({
      ...action,
      rowIndex: action.rowIndex
    })),
    blockPlacements: box.blocks,
    canvasStyle: bodyStyle?.text ?? {},
    styleIssues: styles.issues
  };
  cachePageValue(prepared.layoutCache, normalizedColumns, layout);
  return layout;
}

/** Projects browser-internal semantic content through the legacy terminal-rendered contract. */
export function renderPageContent(content: PageContent, width: number): RenderedPage {
  const contentWidth = documentContentColumns(width);
  const layout = layoutPageContent(content, contentWidth);
  const lineByActionId = new Map(layout.actionPlacements.map((placement) => [placement.actionId, placement.rowIndex]));
  const links: RenderedLink[] = content.links
    .filter((link) => lineByActionId.has(link.id))
    .map((link) => ({
    ...link,
    lineIndex: lineByActionId.get(link.id) ?? 0
  }));
  const actionables: RenderedActionable[] = content.actions
    .filter((action) => lineByActionId.has(action.id))
    .map((action) => ({
    ...action,
    lineIndex: lineByActionId.get(action.id) ?? 0
  }));
  const lines = layout.rows.map((row) => row.text.trimEnd());
  if (links.length > 0) {
    lines.push("", "Links:");
    for (const link of links) {
      lines.push(...wrapLine(
        `[${String(link.index)}] ${link.label} -> ${link.resolvedHref}`,
        Math.max(1, contentWidth - 2)
      ).map((row) => `  ${row.text}`));
    }
  }
  return {
    title: content.title,
    displayUrl: content.displayUrl,
    statusLine: content.statusLine,
    lines,
    links,
    actionables,
    parseErrorCount: content.parseErrorCount,
    fetchedAtIso: content.fetchedAtIso
  };
}

/** Renders semantic page content through the same responsive layout used by the TUI. */
export function renderDocumentToTerminal(input: RenderInput): RenderedPage {
  return renderPageContent(buildPageContent(input), input.width);
}
