// Self-contained so Playwright can serialize this function into a page.
// Text before/after inline children and adjacency across inline boundaries are
// preserved, unlike leaf-element-only text collection.
export function collectVisibleBrowserText() {
  const document = globalThis.document;
  const computedStyle = globalThis.getComputedStyle;
  const textParts = [];
  const textNodes = [];
  const collect = (node) => {
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (parent === null) return;
      const style = computedStyle(parent);
      const range = document.createRange();
      range.selectNodeContents(node);
      if (style.visibility !== "visible" || Number.parseFloat(style.fontSize) === 0
        || ![...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) return;
      textParts.push(node.textContent ?? "");
      if (node.textContent?.trim()) textNodes.push({ text: node.textContent, parentId: parent.id, parentTag: parent.tagName.toLowerCase() });
      return;
    }
    if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName)) return;
    const style = computedStyle(node);
    if (style.display === "none") return;
    const separator = node.tagName === "BR" || !["inline", "contents", "inline-block"].includes(style.display);
    if (separator) textParts.push(" ");
    for (const child of node.childNodes) collect(child);
    if (separator) textParts.push(" ");
  };
  collect(document.body);
  return {
    meaningfulVisibleText: [textParts.join("").replace(/\s+/gu, " ").trim()],
    textNodes,
    readingOrder: textNodes.map((entry) => entry.text)
  };
}
