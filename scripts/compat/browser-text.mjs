// Self-contained so Playwright can serialize this function into a page.
// Observe DOM text, CSSOM string content, and native control text in tree order.
// This is layout-visible text evidence, not a pixel-occlusion test.
export function collectVisibleBrowserText() {
  const document = globalThis.document;
  const computedStyle = globalThis.getComputedStyle;
  const textParts = [];
  const textNodes = [];
  const visibleTextStyle = (style) => style.display !== "none" && style.visibility === "visible" && Number.parseFloat(style.fontSize) !== 0;
  const hasArea = (rects) => [...rects].some((rect) => rect.width > 0 && rect.height > 0);
  const separatesText = (style) => !["inline", "contents", "inline-block"].includes(style.display);
  const append = (text, parent, source) => {
    textParts.push(text);
    if (text.trim()) textNodes.push({ text, parentId: parent.id, parentTag: parent.tagName.toLowerCase(), ...(source === undefined ? {} : { source }) });
  };
  const appendBox = (text, parent, style, source) => {
    const separator = separatesText(style);
    if (separator) textParts.push(" ");
    append(text, parent, source);
    if (separator) textParts.push(" ");
  };
  const contentText = (content) => {
    // CSSOM serializes strings with double quotes and CSS escapes, not JSON
    // escapes. attr() is already resolved to a string by computed style.
    // Only a string list is observable here; counters/quotes/images are not
    // their CSS source text. The optional / alternative is nonvisual text.
    const strings = /"((?:\\[\s\S]|[^"\\])*)"\s*/uy;
    let cursor = 0;
    let result = "";
    while (cursor < content.length) {
      if (content[cursor] === "/") break;
      strings.lastIndex = cursor;
      const match = strings.exec(content);
      if (match === null) return "";
      result += match[1].replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\f\r])|([\s\S]))/giu, (_escape, hex, newline, character) => {
        if (hex !== undefined) {
          const codePoint = Number.parseInt(hex, 16);
          return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? "\ufffd" : String.fromCodePoint(codePoint);
        }
        return newline === undefined ? character : "";
      });
      cursor = strings.lastIndex;
    }
    return result;
  };
  const collectGenerated = (node, pseudo) => {
    const style = computedStyle(node, pseudo);
    if (!visibleTextStyle(style)) return;
    const text = contentText(style.content);
    if (!text) return;
    // A zero-sized originating box can have visible, overflowing generated
    // text. display:contents has no box, so use its box-generating ancestor.
    let origin = node;
    while (origin !== null && computedStyle(origin).display === "contents") origin = origin.parentElement;
    if (origin === null || origin.getClientRects().length === 0) return;
    appendBox(text, node, style, pseudo);
  };
  const optionLabel = (node) => node.label || node.text;
  const collectControl = (node, style) => {
    if (node.tagName === "SELECT" && !node.multiple && node.size <= 1) {
      // The collapsed label uses the select's style, not the option's style
      // or value. Options in the closed popup do not have text range boxes.
      const selected = node.selectedOptions[0];
      if (selected !== undefined && visibleTextStyle(style) && hasArea(node.getClientRects())) append(optionLabel(selected), node, "control");
      return true;
    }
    if (node.tagName === "OPTION") {
      if (visibleTextStyle(style) && hasArea(node.getClientRects())) append(optionLabel(node), node, "control");
      return true;
    }
    if (node.tagName !== "INPUT" && node.tagName !== "TEXTAREA") return false;
    // These input states display their value as text. Passwords and other
    // native widgets must not expose a nonvisual submission value as text.
    const textual = node.tagName === "TEXTAREA" || ["text", "search", "url", "tel", "email", "number", "button", "submit", "reset"].includes(node.type);
    if (hasArea(node.getClientRects())) {
      if (textual && node.value !== "" && visibleTextStyle(style)) append(node.value, node, "control");
      else if (node.matches(":placeholder-shown")) {
        const placeholderStyle = computedStyle(node, "::placeholder");
        if (visibleTextStyle(placeholderStyle)) append(node.placeholder, node, "::placeholder");
      }
    }
    return true;
  };
  const collect = (node) => {
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (parent === null) return;
      const style = computedStyle(parent);
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!visibleTextStyle(style) || !hasArea(range.getClientRects())) return;
      append(node.textContent ?? "", parent);
      return;
    }
    if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName)) return;
    const style = computedStyle(node);
    if (style.display === "none" || style.contentVisibility === "hidden") return;
    const separator = node.tagName === "BR" || separatesText(style);
    if (separator) textParts.push(" ");
    if (!collectControl(node, style)) {
      // Replaced media cannot generate ::before/::after boxes.
      const replaced = ["IMG", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "EMBED", "OBJECT", "SELECT"].includes(node.tagName);
      if (!replaced) collectGenerated(node, "::before");
      for (const child of node.childNodes) collect(child);
      if (!replaced) collectGenerated(node, "::after");
    }
    if (separator) textParts.push(" ");
  };
  collect(document.body);
  return {
    meaningfulVisibleText: [textParts.join("").replace(/\s+/gu, " ").trim()],
    textNodes,
    readingOrder: textNodes.map((entry) => entry.text)
  };
}
