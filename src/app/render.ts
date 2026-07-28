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
  PageLinkAction,
  PageRegion,
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
  "dl",
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
  readonly blocks: PageBlock[];
  readonly links: PageLinkAction[];
  readonly actions: PageAction[];
  readonly formsById: ReadonlyMap<string, FormEntry>;
  nextLinkNumber: number;
}

interface InlineResult {
  readonly text: string;
  readonly links: readonly Omit<PageLinkAction, "blockId">[];
}

interface WrappedRow {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffsetExclusive: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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

function isHidden(node: ElementNode): boolean {
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
    if (!current || current.kind !== "element" || isHidden(current)) continue;
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
    addBlock(collector, anchor, "listItem", `- ${inline.text}`, {
      region: "navigation",
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

function blockId(node: HtmlNode, fallback: number): string {
  return node.kind === "element" ? `node:${String(node.id)}` : `text:${String(fallback)}`;
}

function inlineContent(nodes: readonly HtmlNode[], collector: ContentCollector): InlineResult {
  let text = "";
  const links: Omit<PageLinkAction, "blockId">[] = [];

  const append = (fragment: string): void => {
    const normalized = normalizeWhitespace(fragment);
    if (normalized.length === 0) return;
    if (text.length > 0 && !text.endsWith("\n")) text += " ";
    text += normalized;
  };

  const visit = (node: HtmlNode): void => {
    if (node.kind === "text") {
      append(node.value);
      return;
    }
    if (node.kind !== "element") return;
    const tag = node.localName.toLowerCase();
    if (SKIP_TAGS.has(tag) || isHidden(node)) return;
    if (tag === "br") {
      text = text.trimEnd();
      if (!text.endsWith("\n")) text += "\n";
      return;
    }
    if (tag === "img") {
      const label = imageLabel(node);
      if (label !== null) append(`▧ ${label}`);
      return;
    }
    if (tag === "a") {
      const href = getAttributeValue(node, "href");
      const nested = inlineContent(node.children, collector).text;
      if (!href) {
        append(nested);
        return;
      }
      const label = nested.length > 0 ? nested : href;
      if (text.length > 0 && !text.endsWith("\n")) text += " ";
      const textOffset = text.length;
      const index = collector.nextLinkNumber;
      collector.nextLinkNumber += 1;
      text += label;
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
    for (const child of node.children) visit(child);
  };

  for (const node of nodes) visit(node);
  return { text: text.trim(), links };
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
  } = {}
): void {
  const text = kind === "preformatted"
    ? rawText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trimEnd()
    : rawText.trim();
  if (text.length === 0) return;
  const id = blockId(node, collector.blocks.length);
  collector.blocks.push({
    id,
    kind,
    text,
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
    const inline = inlineContent(inlineNodes, collector);
    const marker = ordered ? `${String(index + 1)}.` : "-";
    addBlock(collector, item, "listItem", `${marker} ${inline.text}`, {
      depth,
      ...(region === undefined ? {} : { region }),
      links: inline.links.map((link) => ({
        ...link,
        textOffset: link.textOffset + marker.length + 1
      }))
    });
    for (const child of item.children) {
      if (child.kind === "element" && ["ul", "ol"].includes(child.localName.toLowerCase())) {
        collectList(child, collector, depth + 1, region);
      }
    }
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
    for (const [cellIndex, cell] of cells.entries()) {
      if (cellIndex > 0) text += " | ";
      const inline = inlineContent(cell.children, collector);
      const cellOffset = text.length;
      text += inline.text;
      links.push(...inline.links.map((link) => ({
        ...link,
        textOffset: cellOffset + link.textOffset
      })));
    }
    text += " |";
    addBlock(collector, row, "tableRow", text, {
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
  inheritedRegion?: PageRegion
): void {
  if (node.kind === "text") {
    const text = normalizeWhitespace(node.value);
    if (text.length > 0) {
      addBlock(collector, node, quoteDepth > 0 ? "quote" : "paragraph", text, {
        depth: quoteDepth,
        ...(inheritedRegion === undefined ? {} : { region: inheritedRegion })
      });
    }
    return;
  }
  if (node.kind !== "element") return;
  const tag = node.localName.toLowerCase();
  if (SKIP_TAGS.has(tag) || isHidden(node)) return;
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
    if (summary !== undefined) collectNode(summary, collector, quoteDepth, region);
    return;
  }
  if (tag === "details") {
    for (const child of node.children) collectNode(child, collector, quoteDepth, region);
    return;
  }
  if (/^h[1-6]$/u.test(tag)) {
    const inline = inlineContent(node.children, collector);
    addBlock(collector, node, "heading", inline.text, {
      level: Number.parseInt(tag.slice(1), 10),
      ...(region === undefined ? {} : { region }),
      links: inline.links
    });
    return;
  }
  if (tag === "pre") {
    addBlock(collector, node, "preformatted", extractCompleteText(node), {
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
      links: inline.links
    });
    return;
  }
  if (tag === "blockquote") {
    for (const child of node.children) collectNode(child, collector, quoteDepth + 1, region);
    return;
  }
  if (tag === "ul" || tag === "ol") {
    collectList(node, collector, 0, region);
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
    const inline = inlineContent(node.children, collector);
    addBlock(collector, node, quoteDepth > 0 ? "quote" : "paragraph", inline.text, {
      depth: quoteDepth,
      ...(region === undefined ? {} : { region }),
      links: inline.links
    });
    return;
  }
  if (CONTAINER_TAGS.has(tag)) {
    for (const child of node.children) collectNode(child, collector, quoteDepth, region);
    return;
  }
  const inline = inlineContent(node.children, collector);
  addBlock(collector, node, quoteDepth > 0 ? "quote" : "paragraph", inline.text, {
    depth: quoteDepth,
    ...(region === undefined ? {} : { region }),
    links: inline.links
  });
}

/** Builds terminal-independent semantic page content from a parsed document. */
export function buildPageContent(input: PageContentInput): PageContent {
  const forms = extractForms(input.tree, input.finalUrl);
  const collector: ContentCollector = {
    baseUrl: input.finalUrl,
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
        { id: "page:blocked", kind: "notice", text: "Blocked by anti-bot challenge." },
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

  return {
    title: firstTitle(input.tree),
    displayUrl: input.finalUrl,
    statusLine: `${String(input.status)} ${input.statusText}`,
    blocks: collector.blocks,
    links: collector.links,
    actions: collector.actions,
    parseErrorCount: input.tree.errors.length,
    fetchedAtIso: input.fetchedAtIso
  };
}

function prefixForBlock(block: PageBlock): string {
  if (block.kind === "quote") return "│ ".repeat(Math.max(1, block.depth ?? 1));
  if (block.kind === "listItem") return "  ".repeat(block.depth ?? 0);
  return "";
}

function wrapLine(value: string, width: number): readonly WrappedRow[] {
  if (value.length === 0) return [{ text: "", startOffset: 0, endOffsetExclusive: 0 }];
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
      endOffsetExclusive
    });
    startIndex = Math.max(startIndex + 1, nextStartIndex);
  }
  return rows;
}

function wrapBlock(block: PageBlock, columns: number): readonly WrappedRow[] {
  const prefix = prefixForBlock(block);
  const width = Math.max(1, columns - measureTextCells(prefix).cells);
  if (block.kind === "preformatted") {
    let offset = 0;
    return block.text.split("\n").map((line) => {
      const row = { text: line, startOffset: offset, endOffsetExclusive: offset + line.length };
      offset += line.length + 1;
      return row;
    });
  }
  const rows: WrappedRow[] = [];
  let lineOffset = 0;
  for (const line of block.text.split("\n")) {
    rows.push(...wrapLine(line, width).map((row) => ({
      ...row,
      startOffset: lineOffset + row.startOffset,
      endOffsetExclusive: lineOffset + row.endOffsetExclusive
    })));
    lineOffset += line.length + 1;
  }
  return rows.map((row, index) => ({
    ...row,
    text: `${index === 0 ? prefix : " ".repeat(prefix.length)}${row.text}`
  }));
}

/** Returns a readable document width with gutters on ordinary terminals. */
export function documentContentColumns(availableColumns: number): number {
  const columns = Math.max(1, Math.floor(availableColumns));
  return columns < 40 ? columns : Math.min(120, columns - 4);
}

function blockGapRows(previous: PageBlock | undefined, current: PageBlock): number {
  if (previous === undefined) return 0;
  if (
    previous.kind === "heading"
    || previous.kind === "listItem" && current.kind === "listItem"
    || previous.kind === "tableRow" && current.kind === "tableRow"
    || previous.region === "navigation" && current.region === "navigation"
  ) {
    return 0;
  }
  return 1;
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
    if (blockGapRows(previous, block) > 0) {
      rows.push({
        blockId: `${block.id}:spacing-before`,
        text: "",
        actionIds: [],
        blockTextStartCodeUnitIndex: 0,
        blockTextEndCodeUnitIndexExclusive: 0
      });
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
        blockTextEndCodeUnitIndexExclusive: row.endOffsetExclusive
      });
      for (const action of blockActions) {
        const actionStart = action.textOffset;
        const actionEnd = action.textOffset + action.label.length;
        const overlapStart = Math.max(actionStart, row.startOffset);
        const overlapEnd = Math.min(actionEnd, row.endOffsetExclusive);
        if (overlapStart >= overlapEnd) continue;
        actionIds.push(action.id);
        const prefixWidth = measureTextCells(prefixForBlock(block)).cells;
        actionPlacements.push({
          actionId: action.id,
          rowIndex: firstRowIndex + localIndex,
          columnIndex: prefixWidth + measureTextCells(
            block.text.slice(row.startOffset, overlapStart)
          ).cells,
          width: Math.max(1, Math.min(
            measureTextCells(block.text.slice(overlapStart, overlapEnd)).cells,
            normalizedColumns
          ))
        });
      }
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
