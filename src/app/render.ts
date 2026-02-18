import {
  findAllByTagName,
  textContent,
  type DocumentTree,
  type ElementNode,
  type HtmlNode
} from "html-parser";

import { resolveHref } from "./url.js";
import type { RenderInput, RenderedLink, RenderedPage } from "./types.js";

const SKIP_TAGS = new Set(["script", "style", "template", "noscript", "head"]);
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "ul"
]);

interface RenderContext {
  readonly baseUrl: string;
  readonly links: RenderedLink[];
}

function normalizeWhitespace(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}

function wrapText(rawText: string, width: number): string[] {
  const cleanedText = normalizeWhitespace(rawText);
  if (cleanedText.length === 0) return [];

  const words = cleanedText.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
      continue;
    }

    if (currentLine.length + 1 + word.length <= width) {
      currentLine += ` ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

function renderInlineNode(node: HtmlNode, context: RenderContext): string {
  if (node.kind === "text") {
    return normalizeWhitespace(node.value);
  }

  if (node.kind !== "element") {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tagName)) {
    return "";
  }

  if (tagName === "br") {
    return "\n";
  }

  if (tagName === "img") {
    const altText = node.attributes.find((attribute) => attribute.name.toLowerCase() === "alt")?.value ?? "";
    return altText.length > 0 ? `[image: ${normalizeWhitespace(altText)}]` : "[image]";
  }

  if (tagName === "a") {
    const href = node.attributes.find((attribute) => attribute.name.toLowerCase() === "href")?.value;
    const label = normalizeWhitespace(renderInlineNodes(node.children, context));

    if (!href) {
      return label;
    }

    const linkIndex = context.links.length + 1;
    const resolvedHref = resolveHref(href, context.baseUrl);

    context.links.push({
      index: linkIndex,
      label: label.length > 0 ? label : href,
      href,
      resolvedHref
    });

    return label.length > 0 ? `${label} [${String(linkIndex)}]` : `[${String(linkIndex)}]`;
  }

  return renderInlineNodes(node.children, context);
}

function renderInlineNodes(nodes: readonly HtmlNode[], context: RenderContext): string {
  const fragments = nodes
    .map((node) => renderInlineNode(node, context))
    .filter((fragment) => fragment.length > 0);

  return fragments
    .join(" ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function headingLevel(tagName: string): number {
  if (!/^h[1-6]$/.test(tagName)) return 1;
  return Number.parseInt(tagName.slice(1), 10);
}

function directChildrenByTagName(node: ElementNode, tagName: string): readonly ElementNode[] {
  return node.children.filter(
    (child): child is ElementNode => child.kind === "element" && child.tagName.toLowerCase() === tagName
  );
}

function renderBlockNode(node: HtmlNode, context: RenderContext): string[] {
  if (node.kind === "text") {
    const text = normalizeWhitespace(node.value);
    return text.length > 0 ? [text] : [];
  }

  if (node.kind !== "element") {
    return [];
  }

  const tagName = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tagName)) {
    return [];
  }

  if (/^h[1-6]$/.test(tagName)) {
    const headingText = renderInlineNodes(node.children, context);
    if (headingText.length === 0) return [];
    return [`${"#".repeat(headingLevel(tagName))} ${headingText}`];
  }

  if (tagName === "pre") {
    const preText = textContent(node).replace(/\r\n/g, "\n").trimEnd();
    return preText.length > 0 ? preText.split("\n") : [];
  }

  if (tagName === "blockquote") {
    const quoteBlocks = renderNodesAsBlocks(node.children, context);
    return quoteBlocks.map((quoteBlock) => `> ${quoteBlock}`);
  }

  if (tagName === "ul" || tagName === "ol") {
    const listItems = directChildrenByTagName(node, "li");
    return listItems.flatMap((listItem, listIndex) => {
      const bulletPrefix = tagName === "ol" ? `${String(listIndex + 1)}.` : "-";
      const listItemText = renderInlineNodes(listItem.children, context);
      if (listItemText.length === 0) return [];
      return [`${bulletPrefix} ${listItemText}`];
    });
  }

  if (tagName === "table") {
    const rowCandidates = node.children.filter(
      (child): child is ElementNode => child.kind === "element" && ["tr", "thead", "tbody", "tfoot"].includes(child.tagName.toLowerCase())
    );

    const rows: ElementNode[] = [];
    for (const rowCandidate of rowCandidates) {
      if (rowCandidate.tagName.toLowerCase() === "tr") {
        rows.push(rowCandidate);
        continue;
      }
      rows.push(...directChildrenByTagName(rowCandidate, "tr"));
    }

    return rows.flatMap((row) => {
      const cells = row.children.filter(
        (child): child is ElementNode => child.kind === "element" && ["td", "th"].includes(child.tagName.toLowerCase())
      );
      const cellTexts = cells
        .map((cell) => renderInlineNodes(cell.children, context))
        .map((cellText) => normalizeWhitespace(cellText))
        .filter((cellText) => cellText.length > 0);
      if (cellTexts.length === 0) {
        return [];
      }
      return [cellTexts.join(" | ")];
    });
  }

  if (tagName === "p" || tagName === "li") {
    const paragraphText = renderInlineNodes(node.children, context);
    return paragraphText.length > 0 ? [paragraphText] : [];
  }

  const childBlocks = renderNodesAsBlocks(node.children, context);
  if (childBlocks.length > 0) {
    return childBlocks;
  }

  if (BLOCK_TAGS.has(tagName)) {
    const fallbackText = renderInlineNodes(node.children, context);
    return fallbackText.length > 0 ? [fallbackText] : [];
  }

  const inlineText = renderInlineNodes(node.children, context);
  return inlineText.length > 0 ? [inlineText] : [];
}

function renderNodesAsBlocks(nodes: readonly HtmlNode[], context: RenderContext): string[] {
  const blocks: string[] = [];

  for (const node of nodes) {
    blocks.push(...renderBlockNode(node, context));
  }

  return blocks.map((block) => block.trim()).filter((block) => block.length > 0);
}

function firstTitle(tree: DocumentTree): string {
  for (const titleNode of findAllByTagName(tree, "title")) {
    const titleText = normalizeWhitespace(textContent(titleNode));
    if (titleText.length > 0) {
      return titleText;
    }
  }
  return "Untitled document";
}

function bodyChildren(tree: DocumentTree): readonly HtmlNode[] {
  for (const bodyNode of findAllByTagName(tree, "body")) {
    return bodyNode.children;
  }
  return tree.children;
}

function wrapBlocks(blocks: readonly string[], width: number): string[] {
  const wrappedLines: string[] = [];
  for (const block of blocks) {
    if (block.includes("\n")) {
      const preLines = block.split("\n");
      for (const preLine of preLines) {
        if (preLine.length === 0) {
          wrappedLines.push("");
          continue;
        }
        wrappedLines.push(...wrapText(preLine, width));
      }
      wrappedLines.push("");
      continue;
    }

    wrappedLines.push(...wrapText(block, width));
    wrappedLines.push("");
  }

  while (wrappedLines.length > 0 && wrappedLines[wrappedLines.length - 1] === "") {
    wrappedLines.pop();
  }

  return wrappedLines;
}

function formatLinkSection(links: readonly RenderedLink[], width: number): string[] {
  if (links.length === 0) {
    return [];
  }

  const lines = ["", "Links:"];
  for (const link of links) {
    const entry = `[${String(link.index)}] ${link.label} -> ${link.resolvedHref}`;
    lines.push(...wrapText(entry, width).map((line) => `  ${line}`));
  }
  return lines;
}

export function renderDocumentToTerminal(input: RenderInput): RenderedPage {
  const links: RenderedLink[] = [];
  const context: RenderContext = {
    baseUrl: input.finalUrl,
    links
  };

  const title = firstTitle(input.tree);
  const blocks = renderNodesAsBlocks(bodyChildren(input.tree), context);
  const contentWidth = Math.max(40, input.width - 2);
  const horizontalRule = "-".repeat(Math.min(Math.max(40, contentWidth), 120));

  const lines: string[] = [
    title,
    input.finalUrl,
    `${String(input.status)} ${input.statusText}`,
    horizontalRule,
    ...wrapBlocks(blocks, contentWidth),
    ...formatLinkSection(links, contentWidth)
  ];

  if (input.tree.errors.length > 0) {
    lines.push("", `Parser reported ${String(input.tree.errors.length)} recoverable issue(s).`);
  }

  return {
    title,
    displayUrl: input.finalUrl,
    statusLine: `${String(input.status)} ${input.statusText}`,
    lines,
    links,
    parseErrorCount: input.tree.errors.length,
    fetchedAtIso: input.fetchedAtIso
  };
}
