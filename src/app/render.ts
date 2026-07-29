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
  PageActionPlacement,
  PageBlock,
  PageBlockKind,
  PageContent,
  PageContentInput,
  PageLayout,
  PageLayoutRow,
  PageLayoutStyleRun,
  PageLinkAction,
  PageRegion,
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
  nextLinkNumber: number;
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

function prunesSubtree(node: ElementNode, styles?: PageStyleResolution): boolean {
  const ariaHidden = getAttributeValue(node, "aria-hidden")?.trim().toLowerCase();
  return hasAttribute(node, "hidden")
    || ariaHidden === "true"
    || (node.localName.toLowerCase() === "dialog" && !hasAttribute(node, "open"))
    || styles?.byElement.get(node)?.display === "none";
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

function navigationAnchors(node: ElementNode, styles: PageStyleResolution): readonly ElementNode[] {
  const anchors: ElementNode[] = [];
  const pending = [...node.children].reverse();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.kind !== "element" || prunesSubtree(current, styles)) continue;
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
  for (const anchor of navigationAnchors(node, collector.styles)) {
    const href = getAttributeValue(anchor, "href");
    if (!href) continue;
    const target = resolveHref(href, collector.baseUrl);
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);
    const inline = inlineContent([anchor], collector);
    addBlock(collector, anchor, "listItem", `- ${inline.text}`, {
      region: "navigation",
      textRuns: offsetTextRuns(inline.textRuns, 2),
      links: inline.links.map((link) => ({ ...link, textOffset: link.textOffset + 2 }))
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
  inheritedStyle?: ComputedElementStyle
): InlineResult {
  let text = "";
  const links: Omit<PageLinkAction, "blockId">[] = [];
  const textRuns: PageTextRun[] = [];

  const appendRun = (fragment: string, style: PageTextStyle): void => {
    if (fragment.length === 0) return;
    const startCodeUnitIndex = text.length;
    text += fragment;
    textRuns.push({
      startCodeUnitIndex,
      endCodeUnitIndexExclusive: text.length,
      style
    });
  };

  const append = (fragment: string, style: ComputedElementStyle | undefined): void => {
    const transformed = transformStyledText(fragment, style?.textTransform ?? "none");
    const whiteSpace = style?.block.whiteSpace ?? "normal";
    if (whiteSpace === "pre" || whiteSpace === "pre-wrap") {
      appendRun(transformed.replace(/\r\n?/gu, "\n"), style?.text ?? DEFAULT_TEXT_STYLE);
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
      appendRun(" ", style?.text ?? DEFAULT_TEXT_STYLE);
    }
    appendRun(normalized, style?.text ?? DEFAULT_TEXT_STYLE);
  };

  const visit = (node: HtmlNode, parentStyle: ComputedElementStyle | undefined): void => {
    if (node.kind === "text") {
      if (parentStyle?.visibility !== "hidden") append(node.value, parentStyle);
      return;
    }
    if (node.kind !== "element") return;
    const tag = node.localName.toLowerCase();
    if (SKIP_TAGS.has(tag) || prunesSubtree(node, collector.styles)) return;
    const style = elementStyle(node, collector) ?? parentStyle;
    if (tag === "br") {
      if (style?.visibility !== "hidden") {
        text = text.trimEnd();
        if (!text.endsWith("\n")) text += "\n";
      }
      return;
    }
    if (tag === "img") {
      if (style?.visibility !== "hidden") {
        const label = imageLabel(node);
        if (label !== null) append(`▧ ${label}`, style);
      }
      return;
    }
    if (tag === "a") {
      const href = getAttributeValue(node, "href");
      if (!href) {
        for (const child of node.children) visit(child, style);
        return;
      }
      if (text.length > 0 && !text.endsWith("\n") && !text.endsWith(" ")) {
        appendRun(" ", style?.text ?? DEFAULT_TEXT_STYLE);
      }
      const textOffset = text.length;
      for (const child of node.children) visit(child, style);
      if (text.length === textOffset && style?.visibility !== "hidden") append(href, style);
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
      style?.visibility !== "hidden"
      && style?.display === "block"
      && text.length > 0
      && !text.endsWith("\n")
    ) {
      appendRun("\n", style.text);
    }
    for (const child of node.children) visit(child, style);
    if (
      style?.visibility !== "hidden"
      && style?.display === "block"
      && text.length > 0
      && !text.endsWith("\n")
    ) {
      appendRun("\n", style.text);
    }
  };

  for (const node of nodes) visit(node, inheritedStyle);
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
    style: style?.text ?? DEFAULT_TEXT_STYLE
  }];
  collector.blocks.push({
    id,
    kind,
    text,
    style: style?.block ?? DEFAULT_BLOCK_STYLE,
    textRuns,
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.region === undefined ? {} : { region: options.region })
  });
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
    const inline = inlineContent(inlineNodes, collector, elementStyle(item, collector));
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
    const inline = inlineContent(item.children, collector, elementStyle(item, collector));
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
      const inline = inlineContent(cell.children, collector, elementStyle(cell, collector));
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
        style: elementStyle(row, collector)?.block ?? DEFAULT_BLOCK_STYLE,
        textRuns: [],
        ...(region === undefined ? {} : { region })
      });
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
  const radioGroups = new Set<string>();
  const controlRows: number[] = [];
  for (const control of visibleControls) {
    if (control.kind === "radio") {
      const groupName = control.name.length === 0 ? control.id : control.name;
      if (radioGroups.has(groupName)) continue;
      radioGroups.add(groupName);
      const optionCount = visibleControls.filter((candidate) =>
        candidate.kind === "radio"
        && (control.name.length === 0 ? candidate.id === control.id : candidate.name === control.name)
      ).length;
      controlRows.push(optionCount + 1);
      continue;
    }
    if (control.kind === "text") controlRows.push(2);
    else if (control.kind === "textarea") controlRows.push(3);
    else if (control.kind === "select" && control.multiple) controlRows.push(control.options.length + 1);
    else controlRows.push(1);
  }
  const rowCount = Math.max(
    2,
    controlRows.reduce((sum, rows) => sum + rows, 0) + Math.max(0, controlRows.length - 1)
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
    style: elementStyle(node, collector)?.block ?? DEFAULT_BLOCK_STYLE,
    textRuns: [{
      startCodeUnitIndex: 0,
      endCodeUnitIndexExclusive: text.length,
      style: elementStyle(node, collector)?.text ?? DEFAULT_TEXT_STYLE
    }],
    ...(region === undefined ? {} : { region })
  };
  collector.blocks.push(block);
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
    if (inheritedStyle?.visibility === "hidden") return;
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
  if (SKIP_TAGS.has(tag) || prunesSubtree(node, collector.styles)) return;
  const currentStyle = elementStyle(node, collector) ?? inheritedStyle;
  const region = pageRegion(node, inheritedRegion);
  if (tag === "form" && currentStyle?.visibility === "hidden") return;
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
    const inline = inlineContent(node.children, collector, elementStyle(node, collector));
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
    const inline = inlineContent(node.children, collector, elementStyle(node, collector));
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
  const inline = inlineContent(node.children, collector, elementStyle(node, collector));
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
  const styles = resolvePageStyles(
    input.tree,
    input.stylesheets ?? [],
    input.stylesheetIssues ?? [],
    { authorStyles: input.authorStyles ?? "apply" }
  );
  const forms = extractForms(input.tree, baseUrl);
  const collector: ContentCollector = {
    baseUrl,
    styles,
    blocks: [],
    links: [],
    actions: [],
    formsById: new Map(forms.map((form) => [form.id, form])),
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
          text: "Blocked by anti-bot challenge.",
          style: DEFAULT_BLOCK_STYLE,
          textRuns: []
        },
        {
          id: "page:blocked-detail",
          kind: "notice",
          text: "This page requires JavaScript/browser verification and cannot be rendered in CLI mode.",
          style: DEFAULT_BLOCK_STYLE,
          textRuns: []
        }
      );
    } else {
      collector.blocks.push({
        id: "page:empty",
        kind: "notice",
        text: "No visible content after script/style filtering.",
        style: DEFAULT_BLOCK_STYLE,
        textRuns: []
      });
    }
  }
  if (input.tree.errors.length > 0) {
    collector.blocks.push({
      id: "page:parse-errors",
      kind: "notice",
      text: `Parser reported ${String(input.tree.errors.length)} recoverable issue(s).`,
      style: DEFAULT_BLOCK_STYLE,
      textRuns: []
    });
  }

  return {
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

function wrapBlock(block: PageBlock, columns: number): readonly WrappedRow[] {
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
  return columns < 40 ? columns : Math.min(96, columns - 4);
}

function blockGapRows(previous: PageBlock | undefined, current: PageBlock): number {
  if (previous === undefined) return current.style.marginTopRows;
  const authorGap = Math.max(previous.style.marginBottomRows, current.style.marginTopRows);
  if (
    previous.kind === "heading"
    || previous.kind === "listItem" && current.kind === "listItem"
    || previous.kind === "tableRow" && current.kind === "tableRow"
    || previous.kind.startsWith("definition") && current.kind.startsWith("definition")
    || previous.region === "navigation" && current.region === "navigation"
  ) {
    return authorGap;
  }
  return Math.max(1, authorGap);
}

function styleRunsForRow(block: PageBlock, row: WrappedRow): readonly PageLayoutStyleRun[] {
  return block.textRuns.flatMap((run): PageLayoutStyleRun[] => {
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

function spacingRow(
  blockId: string,
  columns: number,
  background = undefined as PageBlock["style"]["background"],
  horizontalMargins: {
    readonly left: number;
    readonly right: number;
  } = { left: 0, right: 0 }
): PageLayoutRow {
  const backgroundWidth = Math.max(0, columns - horizontalMargins.left - horizontalMargins.right);
  return {
    blockId,
    text: background === undefined
      ? ""
      : `${" ".repeat(horizontalMargins.left)}${" ".repeat(backgroundWidth)}`,
    actionIds: [],
    blockTextStartCodeUnitIndex: 0,
    blockTextEndCodeUnitIndexExclusive: 0,
    contentStartCodeUnitIndex: 0,
    styleRuns: [],
    ...(background === undefined
      ? {}
      : {
        background,
        backgroundStartCodeUnitIndex: horizontalMargins.left,
        backgroundEndCodeUnitIndexExclusive: horizontalMargins.left + backgroundWidth
      })
  };
}

/** Derives terminal rows and action geometry from semantic page content. */
export function layoutPageContent(content: PageContent, columns: number): PageLayout {
  const normalizedColumns = Math.max(1, Math.floor(columns));
  const rows: PageLayoutRow[] = [];
  const actionPlacements: PageActionPlacement[] = [];
  const actionsByBlock = new Map<string, PageAction[]>();
  for (const action of content.actions) {
    const actions = actionsByBlock.get(action.blockId) ?? [];
    actions.push(action);
    actionsByBlock.set(action.blockId, actions);
  }

  for (const [blockIndex, block] of content.blocks.entries()) {
    const previous = content.blocks[blockIndex - 1];
    for (let gap = 0; gap < blockGapRows(previous, block); gap += 1) {
      rows.push(spacingRow(`${block.id}:spacing-before:${String(gap)}`, normalizedColumns));
    }
    for (let padding = 0; padding < block.style.paddingTopRows; padding += 1) {
      rows.push(spacingRow(
        block.id,
        normalizedColumns,
        block.style.background,
        { left: block.style.marginLeftCells, right: block.style.marginRightCells }
      ));
    }
    const blockRows = wrapBlock(block, normalizedColumns);
    const blockActions = actionsByBlock.get(block.id) ?? [];
    const firstRowIndex = rows.length;
    for (const [localIndex, row] of blockRows.entries()) {
      const actionIds: string[] = [];
      rows.push({
        blockId: block.id,
        text: row.text,
        actionIds,
        blockTextStartCodeUnitIndex: row.startOffset,
        blockTextEndCodeUnitIndexExclusive: row.endOffsetExclusive,
        contentStartCodeUnitIndex: row.contentStartCodeUnitIndex,
        styleRuns: styleRunsForRow(block, row),
        ...(block.style.background === undefined
          ? {}
          : {
            background: block.style.background,
            backgroundStartCodeUnitIndex: block.style.marginLeftCells,
            backgroundEndCodeUnitIndexExclusive:
              Math.max(block.style.marginLeftCells, normalizedColumns - block.style.marginRightCells)
          })
      });
      for (const action of blockActions) {
        const actionStart = action.textOffset;
        const actionEnd = action.textOffset + action.label.length;
        const overlapStart = Math.max(actionStart, row.startOffset);
        const overlapEnd = Math.min(actionEnd, row.endOffsetExclusive);
        if (overlapStart >= overlapEnd) continue;
        actionIds.push(action.id);
        actionPlacements.push({
          actionId: action.id,
          rowIndex: firstRowIndex + localIndex,
          columnIndex: measureTextCells(row.text.slice(0, row.contentStartCodeUnitIndex)).cells
            + measureTextCells(
            block.text.slice(row.startOffset, overlapStart)
          ).cells,
          width: Math.max(1, Math.min(
            measureTextCells(block.text.slice(overlapStart, overlapEnd)).cells,
            normalizedColumns
          ))
        });
      }
    }
    for (let padding = 0; padding < block.style.paddingBottomRows; padding += 1) {
      rows.push(spacingRow(
        block.id,
        normalizedColumns,
        block.style.background,
        { left: block.style.marginLeftCells, right: block.style.marginRightCells }
      ));
    }
  }
  const lastBlock = content.blocks.at(-1);
  if (lastBlock) {
    for (let gap = 0; gap < lastBlock.style.marginBottomRows; gap += 1) {
      rows.push(spacingRow(
        `${lastBlock.id}:spacing-after:${String(gap)}`,
        normalizedColumns
      ));
    }
  }
  return { columns: normalizedColumns, rows, actionPlacements };
}

/** Renders semantic page content through the same responsive layout used by the TUI. */
export function renderDocumentToTerminal(input: RenderInput): RenderedPage {
  const content = buildPageContent(input);
  const contentWidth = documentContentColumns(input.width);
  const layout = layoutPageContent(content, contentWidth);
  const lineByActionId = new Map(layout.actionPlacements.map((placement) => [placement.actionId, placement.rowIndex]));
  const links: RenderedLink[] = content.links.map((link) => ({
    ...link,
    lineIndex: lineByActionId.get(link.id) ?? 0
  }));
  const actionables: RenderedActionable[] = content.actions.map((action) => ({
    ...action,
    lineIndex: lineByActionId.get(action.id) ?? 0
  }));
  const lines = layout.rows.map((row) => row.text);
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
