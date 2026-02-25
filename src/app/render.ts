import {
  findAllByTagName,
  textContent,
  type DocumentTree,
  type ElementNode,
  type HtmlNode
} from "html-parser";

import { resolveHref } from "./url.js";
import type { RenderInput, RenderedLink, RenderedPage } from "./types.js";

const SKIP_TAGS = new Set(["script", "style", "template", "head"]);
const PRE_BLOCK_PREFIX = "@@PRE@@";
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

function wrapTextWithIndent(rawText: string, width: number): string[] {
  const indentMatch = rawText.match(/^(\s+)/);
  const indent = indentMatch?.[1] ?? "";
  if (indent.length === 0) {
    return wrapText(rawText, width);
  }
  const content = rawText.slice(indent.length);
  const contentWidth = Math.max(10, width - indent.length);
  return wrapText(content, contentWidth).map((line) => `${indent}${line}`);
}

function indentLines(lines: readonly string[], prefix: string): string[] {
  if (lines.length === 0) return [];
  return lines.map((line) => `${prefix}${line}`);
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
    const preText = textContent(node).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
    return preText.length > 0 ? [`${PRE_BLOCK_PREFIX}${preText}`] : [];
  }

  if (tagName === "blockquote") {
    const quoteBlocks = renderNodesAsBlocks(node.children, context);
    return indentLines(quoteBlocks, "> ");
  }

  if (tagName === "ul" || tagName === "ol") {
    const listItems = directChildrenByTagName(node, "li");
    const listLines: string[] = [];
    for (const [listIndex, listItem] of listItems.entries()) {
      const bulletPrefix = tagName === "ol" ? `${String(listIndex + 1)}.` : "-";
      const summaryParts: string[] = [];
      const nestedBlocks: string[] = [];

      for (const child of listItem.children) {
        if (child.kind === "text") {
          const text = normalizeWhitespace(child.value);
          if (text.length > 0) {
            summaryParts.push(text);
          }
          continue;
        }

        if (child.kind !== "element") {
          continue;
        }

        const childTagName = child.tagName.toLowerCase();
        if (childTagName === "ul" || childTagName === "ol") {
          nestedBlocks.push(...renderBlockNode(child, context));
          continue;
        }

        if (BLOCK_TAGS.has(childTagName) || childTagName === "table") {
          nestedBlocks.push(...renderBlockNode(child, context));
          continue;
        }

        const inlineText = renderInlineNode(child, context);
        if (inlineText.length > 0) {
          summaryParts.push(inlineText);
        }
      }

      const summary = normalizeWhitespace(summaryParts.join(" "));
      listLines.push(summary.length > 0 ? `${bulletPrefix} ${summary}` : bulletPrefix);
      listLines.push(...indentLines(nestedBlocks, "  "));
    }
    return listLines;
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

    const tableMatrix = rows.map((row) => {
      const cells = row.children.filter(
        (child): child is ElementNode => child.kind === "element" && ["td", "th"].includes(child.tagName.toLowerCase())
      );
      return cells
        .map((cell) => renderInlineNodes(cell.children, context))
        .map((cellText) => normalizeWhitespace(cellText))
        .filter((cellText) => cellText.length > 0);
    });

    const nonEmptyRows = tableMatrix.filter((row) => row.length > 0);
    if (nonEmptyRows.length === 0) {
      return [];
    }

    const columnCount = Math.max(...nonEmptyRows.map((row) => row.length));
    const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) => {
      const width = Math.max(
        3,
        ...nonEmptyRows.map((row) => row[columnIndex]?.length ?? 0)
      );
      return Math.min(24, width);
    });

    const renderedRows = nonEmptyRows.map((row) => {
      const renderedCells = columnWidths.map((columnWidth, columnIndex) => {
        const value = row[columnIndex] ?? "";
        return value.padEnd(columnWidth, " ");
      });
      return `| ${renderedCells.join(" | ")} |`;
    });

    if (renderedRows.length === 1) {
      return renderedRows;
    }

    const separator = `| ${columnWidths.map((columnWidth) => "-".repeat(columnWidth)).join(" | ")} |`;
    return [renderedRows[0] ?? "", separator, ...renderedRows.slice(1)];
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

  return blocks.map((block) => block.trimEnd()).filter((block) => block.trim().length > 0);
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
    if (block.startsWith(PRE_BLOCK_PREFIX)) {
      const preText = block.slice(PRE_BLOCK_PREFIX.length);
      const preLines = preText.split("\n");
      wrappedLines.push(...preLines);
      wrappedLines.push("");
      continue;
    }

    if (block.includes("\n")) {
      const preLines = block.split("\n");
      for (const preLine of preLines) {
        if (preLine.length === 0) {
          wrappedLines.push("");
          continue;
        }
        wrappedLines.push(...wrapTextWithIndent(preLine, width));
      }
      wrappedLines.push("");
      continue;
    }

    wrappedLines.push(...wrapTextWithIndent(block, width));
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
  const wrappedContent = wrapBlocks(blocks, contentWidth);
  const lines: string[] = [...wrappedContent, ...formatLinkSection(links, contentWidth)];
  if (lines.length === 0) {
    const normalizedTitle = title.toLowerCase();
    if (input.status === 403 && normalizedTitle.includes("just a moment")) {
      lines.push("Blocked by anti-bot challenge.");
      lines.push("This page requires JavaScript/browser verification and cannot be rendered in CLI mode.");
    } else {
      lines.push("No visible content after script/style filtering.");
    }
  }

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
