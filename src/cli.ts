#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { outline as buildOutline, type Edit } from "html-parser";

import { formatHelpText, parseCommand, type BrowserCommand } from "./app/commands.js";
import {
  createPager,
  pagerBottom,
  pagerJumpToLine,
  pagerLineDown,
  pagerLineUp,
  pagerPageDown,
  pagerPageUp,
  pagerTop,
  pagerViewport,
  setPagerLines,
  type PagerState
} from "./app/pager.js";
import { buildFormSubmissionRequest, extractForms } from "./app/forms.js";
import { activeSearchLineIndex, createSearchState, moveSearchMatch, type SearchState } from "./app/search.js";
import { resolveShortcutAction } from "./app/shortcuts.js";
import { BrowserSession } from "./app/session.js";
import { BrowserStore } from "./app/storage.js";
import { clearTerminal, terminalHeight, terminalWidth } from "./app/terminal.js";
import type { KeyboardKey, PageRequestOptions, PageSnapshot } from "./app/types.js";
import { resolveInputUrl } from "./app/url.js";

type ViewKind = "page" | "reader" | "help" | "links" | "bookmarks" | "history" | "cookies" | "recall" | "forms" | "diag" | "outline";

interface ActiveView {
  readonly kind: ViewKind;
  readonly title: string;
  readonly lines: readonly string[];
}

function pageSizeFromTerminal(): number {
  return Math.max(6, terminalHeight() - 5);
}

function dividerLine(): string {
  return "-".repeat(Math.min(Math.max(40, terminalWidth()), 120));
}

function normalizeLineForExcerpt(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function composeExcerpt(lines: readonly string[]): string {
  const excerpt = lines
    .slice(0, 8)
    .map((line) => normalizeLineForExcerpt(line))
    .filter((line) => line.length > 0)
    .join(" ")
    .slice(0, 220)
    .trim();
  return excerpt;
}

function formatBookmarksView(bookmarks: ReturnType<BrowserStore["listBookmarks"]>): readonly string[] {
  if (bookmarks.length === 0) {
    return ["No bookmarks saved."];
  }

  const lines = ["Bookmarks:", ""];
  for (const [index, bookmark] of bookmarks.entries()) {
    lines.push(`[${String(index + 1)}] ${bookmark.name}`);
    lines.push(`    ${bookmark.url}`);
    lines.push(`    added: ${bookmark.addedAtIso}`);
    lines.push("");
  }

  return lines;
}

function formatHistoryView(historyEntries: ReturnType<BrowserStore["listHistory"]>): readonly string[] {
  if (historyEntries.length === 0) {
    return ["No history entries available."];
  }

  const lines = ["History:", ""];
  for (const [index, historyEntry] of historyEntries.entries()) {
    lines.push(`[${String(index + 1)}] ${historyEntry.title}`);
    lines.push(`    ${historyEntry.url}`);
    lines.push(`    visited: ${historyEntry.visitedAtIso}`);
    if (historyEntry.excerpt && historyEntry.excerpt.trim().length > 0) {
      lines.push(`    excerpt: ${historyEntry.excerpt}`);
    }
    lines.push("");
  }

  return lines;
}

function formatCookiesView(cookies: ReturnType<BrowserStore["listCookies"]>): readonly string[] {
  if (cookies.length === 0) {
    return ["No cookies stored."];
  }
  const lines = ["Cookies:", ""];
  for (const cookie of cookies) {
    const scope = `${cookie.domain}${cookie.path}`;
    const expires = cookie.expiresAtIso ?? "session";
    const flags = [
      cookie.hostOnly ? "hostOnly" : "domain",
      cookie.secure ? "secure" : "plain",
      cookie.httpOnly ? "httpOnly" : "scriptVisible",
      cookie.sameSite ? `sameSite=${cookie.sameSite}` : "sameSite=unset"
    ];
    lines.push(`${cookie.name}=${cookie.value}`);
    lines.push(`    scope: ${scope}`);
    lines.push(`    flags: ${flags.join(", ")}`);
    lines.push(`    expires: ${expires}`);
    lines.push("");
  }
  return lines;
}

function formatRecallView(results: ReturnType<BrowserStore["searchIndex"]>): readonly string[] {
  if (results.length === 0) {
    return ["No index matches."];
  }
  const lines = ["Recall results:", ""];
  for (const [index, result] of results.entries()) {
    lines.push(`[${String(index + 1)}] ${result.title} (score=${String(result.score)})`);
    lines.push(`    ${result.url}`);
    lines.push(`    ${result.excerpt}`);
    lines.push("");
  }
  return lines;
}

function formatLinksView(snapshot: PageSnapshot | null): readonly string[] {
  if (!snapshot) {
    return ["No page loaded."];
  }

  if (snapshot.rendered.links.length === 0) {
    return ["No links on current page."];
  }

  const lines = ["Links:", ""];
  for (const link of snapshot.rendered.links) {
    lines.push(`[${String(link.index)}] ${link.label}`);
    lines.push(`    ${link.resolvedHref}`);
    lines.push("");
  }
  return lines;
}

function formatFormsView(snapshot: PageSnapshot | null): readonly string[] {
  if (!snapshot) {
    return ["No page loaded."];
  }

  const forms = extractForms(snapshot.tree, snapshot.finalUrl);
  if (forms.length === 0) {
    return ["No forms on current page."];
  }

  const lines = ["Forms:", ""];
  for (const form of forms) {
    lines.push(`[${String(form.index)}] method=${form.method.toUpperCase()} action=${form.actionUrl}`);
    if (form.fields.length === 0) {
      lines.push("    fields: (none)");
      lines.push("");
      continue;
    }
    for (const field of form.fields) {
      lines.push(`    ${field.name} (${field.type}) = ${field.value}`);
    }
    lines.push("");
  }
  return lines;
}

function formatDiagnosticsView(snapshot: PageSnapshot | null): readonly string[] {
  if (!snapshot) {
    return ["No page loaded."];
  }

  const lines = [
    "Diagnostics:",
    "",
    `url: ${snapshot.finalUrl}`,
    `status: ${String(snapshot.status)} ${snapshot.statusText}`,
    `parse mode: ${snapshot.diagnostics.parseMode}`,
    `request method: ${snapshot.diagnostics.requestMethod}`,
    `used cookies: ${snapshot.diagnostics.usedCookies ? "yes" : "no"}`,
    `source bytes: ${snapshot.diagnostics.sourceBytes === null ? "unavailable" : String(snapshot.diagnostics.sourceBytes)}`,
    `parse errors: ${String(snapshot.diagnostics.parseErrorCount)}`,
    `trace events: ${String(snapshot.diagnostics.traceEventCount)}`,
    `trace kinds: ${snapshot.diagnostics.traceKinds.length === 0 ? "(none)" : snapshot.diagnostics.traceKinds.join(", ")}`,
    `fetch ms: ${String(snapshot.diagnostics.fetchDurationMs)}`,
    `parse ms: ${String(snapshot.diagnostics.parseDurationMs)}`,
    `render ms: ${String(snapshot.diagnostics.renderDurationMs)}`,
    `total ms: ${String(snapshot.diagnostics.totalDurationMs)}`
  ];

  return lines;
}

function formatReaderView(snapshot: PageSnapshot | null): readonly string[] {
  if (!snapshot) {
    return ["No page loaded."];
  }
  const readerLines = snapshot.rendered.lines
    .filter((line) => !/^Links:$/i.test(line.trim()))
    .filter((line) => !/^\s+\[\d+\]\s/.test(line))
    .filter((line) => !/^Parser reported \d+ recoverable issue\(s\)\.?$/i.test(line.trim()))
    .map((line) => line.replace(/\s+\[\d+\]/g, ""))
    .map((line) => line.trimEnd());

  const compact = readerLines.filter((line, index, lines) => {
    if (line.length > 0) {
      return true;
    }
    return lines[index - 1] !== "";
  });
  return compact.length > 0 ? compact : ["No readable content."];
}

function formatOutlineView(snapshot: PageSnapshot | null): readonly string[] {
  if (!snapshot) {
    return ["No page loaded."];
  }

  const outline = buildOutline(snapshot.tree);
  if (outline.entries.length === 0) {
    return ["No outline entries on current page."];
  }

  const lines = ["Outline:", ""];
  for (const entry of outline.entries) {
    const indent = "  ".repeat(Math.max(0, entry.depth - 1));
    lines.push(`${indent}- [${String(entry.nodeId)}] <${entry.tagName}> ${entry.text}`);
  }
  return lines;
}

type KeypressListener = (character: string, key: KeyboardKey) => void;

function attachKeypressListener(listener: KeypressListener): void {
  stdin.on("keypress", listener);
}

function detachKeypressListener(listener: KeypressListener): void {
  stdin.off("keypress", listener);
}

async function main(): Promise<void> {
  const session = new BrowserSession({
    widthProvider: terminalWidth
  });
  const store = await BrowserStore.open();

  const commandInterface = createInterface({
    input: stdin,
    output: stdout,
    terminal: true
  });

  let activeView: ActiveView = {
    kind: "help",
    title: "verge-browser help",
    lines: formatHelpText().split("\n")
  };
  let statusMessage = "";
  const pager: PagerState = createPager(activeView.lines, pageSizeFromTerminal());
  let searchState: SearchState | null = null;
  let lastRecallResults: ReturnType<BrowserStore["searchIndex"]> = [];
  let promptActive = false;
  let exiting = false;
  let resolveExit: (() => void) | null = null;
  let inputQueue: Promise<void> = Promise.resolve();

  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  function render(): void {
    const viewport = pagerViewport(pager);
    clearTerminal();

    stdout.write(`${activeView.title}\n`);
    stdout.write(`${dividerLine()}\n`);
    if (viewport.lines.length === 0) {
      stdout.write("(no content)\n");
    } else {
      stdout.write(`${viewport.lines.join("\n")}\n`);
    }

    stdout.write(`${dividerLine()}\n`);
    const rangeText = viewport.totalLines === 0
      ? "0/0"
      : `${String(viewport.startLine)}-${String(viewport.endLine)}/${String(viewport.totalLines)}`;
    stdout.write(`view=${activeView.kind}  lines=${rangeText}  page=${String(viewport.pageIndex)}/${String(viewport.pageCount)}\n`);

    if (statusMessage.length > 0) {
      stdout.write(`${statusMessage}\n`);
    }
    stdout.write("keys: j/k scroll, space/b page, g/G top/bottom, / n N search, h/f/r nav, l links, o outline, d diag, m bookmark, H history, : command, q quit\n");
  }

  function setStatus(message: string): void {
    statusMessage = message;
  }

  function setView(view: ActiveView, resetToTop: boolean): void {
    activeView = view;
    setPagerLines(pager, view.lines, pageSizeFromTerminal());
    searchState = null;
    if (resetToTop) {
      pagerTop(pager);
    }
  }

  function jumpToActiveSearchMatch(): void {
    if (!searchState) {
      return;
    }
    const lineIndex = activeSearchLineIndex(searchState);
    if (lineIndex === null) {
      return;
    }
    pagerJumpToLine(pager, lineIndex);
  }

  function runSearch(query: string): void {
    const nextSearchState = createSearchState(activeView.lines, query);
    searchState = nextSearchState;
    if (nextSearchState.matchLineIndices.length === 0) {
      setStatus(`No matches for "${query}"`);
      return;
    }
    jumpToActiveSearchMatch();
    setStatus(`Match 1/${String(nextSearchState.matchLineIndices.length)} for "${nextSearchState.query}"`);
  }

  function moveSearch(direction: "next" | "prev"): void {
    if (!searchState || searchState.matchLineIndices.length === 0) {
      setStatus("No active search; use / or find <query>");
      return;
    }
    searchState = moveSearchMatch(searchState, direction);
    jumpToActiveSearchMatch();
    const index = (searchState.activeMatchIndex + 1);
    setStatus(`Match ${String(index)}/${String(searchState.matchLineIndices.length)} for "${searchState.query}"`);
  }

  function showPage(resetToTop: boolean): void {
    const currentPage = session.current;
    if (!currentPage) {
      setView({ kind: "help", title: "verge-browser help", lines: formatHelpText().split("\n") }, true);
      return;
    }

    setView(
      {
        kind: "page",
        title: `${currentPage.rendered.title} (${currentPage.finalUrl})`,
        lines: currentPage.rendered.lines
      },
      resetToTop
    );
  }

  function quit(): void {
    exiting = true;
    resolveExit?.();
  }

  function handleResize(): void {
    setPagerLines(pager, activeView.lines, pageSizeFromTerminal());
    render();
  }

  function attachCookieHeader(targetUrl: string, requestOptions: PageRequestOptions): PageRequestOptions {
    const mergedHeaders: Record<string, string> = {
      ...(requestOptions.headers ?? {})
    };
    const hasCookieHeader = Object.keys(mergedHeaders).some((name) => name.toLowerCase() === "cookie");
    if (!hasCookieHeader) {
      const cookieHeader = store.cookieHeaderForUrl(targetUrl);
      if (cookieHeader) {
        mergedHeaders.cookie = cookieHeader;
      }
    }
    return {
      ...requestOptions,
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {})
    };
  }

  async function persistSnapshot(snapshot: PageSnapshot): Promise<void> {
    if (snapshot.setCookieHeaders.length > 0) {
      await store.applySetCookieHeaders(snapshot.finalUrl, snapshot.setCookieHeaders);
    }
    const excerpt = composeExcerpt(snapshot.rendered.lines);
    await store.recordHistory(snapshot.finalUrl, snapshot.rendered.title, excerpt);
    await store.recordIndexDocument(snapshot.finalUrl, snapshot.rendered.title, snapshot.rendered.lines.join("\n"));
  }

  async function navigateToTarget(
    rawTarget: string,
    parseMode: "text" | "stream" = "text",
    requestOptions: PageRequestOptions = {}
  ): Promise<void> {
    const currentUrl = session.current?.finalUrl;
    const resolvedTarget = resolveInputUrl(rawTarget, currentUrl);
    const finalRequestOptions = attachCookieHeader(resolvedTarget, requestOptions);
    const snapshot = await session.openWithRequest(resolvedTarget, finalRequestOptions, parseMode);
    await persistSnapshot(snapshot);
    showPage(true);
    const parseModeLabel = parseMode === "stream" ? " (stream)" : "";
    setStatus(`Opened ${snapshot.finalUrl}${parseModeLabel} [${snapshot.diagnostics.requestMethod}]`);
  }

  async function executeCommand(command: BrowserCommand): Promise<void> {
    if (command.kind === "invalid") {
      setStatus(`Invalid command: ${command.reason}`);
      return;
    }

    switch (command.kind) {
      case "quit": {
        quit();
        return;
      }
      case "help": {
        setView({ kind: "help", title: "verge-browser help", lines: formatHelpText().split("\n") }, true);
        setStatus("Help view");
        return;
      }
      case "view": {
        showPage(false);
        setStatus("Page view");
        return;
      }
      case "reader": {
        setView({ kind: "reader", title: "Reader view", lines: formatReaderView(session.current) }, true);
        setStatus("Reader view");
        return;
      }
      case "links": {
        setView({ kind: "links", title: "Links", lines: formatLinksView(session.current) }, true);
        setStatus("Links view");
        return;
      }
      case "diag": {
        setView({ kind: "diag", title: "Diagnostics", lines: formatDiagnosticsView(session.current) }, true);
        setStatus("Diagnostics view");
        return;
      }
      case "outline": {
        setView({ kind: "outline", title: "Outline", lines: formatOutlineView(session.current) }, true);
        setStatus("Outline view");
        return;
      }
      case "page-down": {
        pagerPageDown(pager);
        return;
      }
      case "page-up": {
        pagerPageUp(pager);
        return;
      }
      case "page-top": {
        pagerTop(pager);
        return;
      }
      case "page-bottom": {
        pagerBottom(pager);
        return;
      }
      case "find": {
        runSearch(command.query);
        return;
      }
      case "find-next": {
        moveSearch("next");
        return;
      }
      case "find-prev": {
        moveSearch("prev");
        return;
      }
      case "back": {
        const snapshot = await session.back();
        await persistSnapshot(snapshot);
        showPage(true);
        setStatus(`Back -> ${snapshot.finalUrl}`);
        return;
      }
      case "forward": {
        const snapshot = await session.forward();
        await persistSnapshot(snapshot);
        showPage(true);
        setStatus(`Forward -> ${snapshot.finalUrl}`);
        return;
      }
      case "reload": {
        const snapshot = await session.reload();
        await persistSnapshot(snapshot);
        showPage(true);
        setStatus(`Reloaded ${snapshot.finalUrl}`);
        return;
      }
      case "open-link": {
        const snapshot = await session.openLink(command.index);
        await persistSnapshot(snapshot);
        showPage(true);
        setStatus(`Opened link [${String(command.index)}]`);
        return;
      }
      case "go": {
        await navigateToTarget(command.target);
        return;
      }
      case "go-stream": {
        await navigateToTarget(command.target, "stream");
        return;
      }
      case "bookmark-list": {
        setView({ kind: "bookmarks", title: "Bookmarks", lines: formatBookmarksView(store.listBookmarks()) }, true);
        setStatus("Bookmarks view");
        return;
      }
      case "bookmark-add": {
        const currentPage = session.current;
        if (!currentPage) {
          setStatus("Cannot bookmark without a loaded page");
          return;
        }

        const bookmarkName = command.name ?? currentPage.rendered.title;
        const bookmark = await store.addBookmark(currentPage.finalUrl, bookmarkName);
        setStatus(`Saved bookmark: ${bookmark.name}`);
        return;
      }
      case "bookmark-open": {
        const bookmark = store.listBookmarks()[command.index - 1];
        if (!bookmark) {
          setStatus(`No bookmark at index ${String(command.index)}`);
          return;
        }

        const snapshot = await session.openWithRequest(bookmark.url, attachCookieHeader(bookmark.url, {}));
        await persistSnapshot(snapshot);
        showPage(true);
        setStatus(`Opened bookmark [${String(command.index)}]`);
        return;
      }
      case "cookie-list": {
        setView({ kind: "cookies", title: "Cookies", lines: formatCookiesView(store.listCookies()) }, true);
        setStatus("Cookie store view");
        return;
      }
      case "cookie-clear": {
        await store.clearCookies();
        setStatus("Cookie store cleared");
        return;
      }
      case "history-list": {
        setView({ kind: "history", title: "History", lines: formatHistoryView(store.listHistory()) }, true);
        setStatus("History view");
        return;
      }
      case "history-open": {
        const historyEntry = store.listHistory()[command.index - 1];
        if (!historyEntry) {
          setStatus(`No history entry at index ${String(command.index)}`);
          return;
        }

        const snapshot = await session.openWithRequest(historyEntry.url, attachCookieHeader(historyEntry.url, {}));
        await persistSnapshot(snapshot);
        showPage(true);
        setStatus(`Opened history [${String(command.index)}]`);
        return;
      }
      case "recall": {
        const results = store.searchIndex(command.query, 20);
        lastRecallResults = results;
        setView({ kind: "recall", title: `Recall: ${command.query}`, lines: formatRecallView(results) }, true);
        setStatus(`Recall results: ${String(results.length)}`);
        return;
      }
      case "recall-open": {
        const result = lastRecallResults[command.index - 1];
        if (!result) {
          setStatus(`No recall result at index ${String(command.index)}. Run: recall <query>`);
          return;
        }
        const snapshot = await session.openWithRequest(result.url, attachCookieHeader(result.url, {}));
        await persistSnapshot(snapshot);
        showPage(true);
        setStatus(`Opened recall result [${String(command.index)}]`);
        return;
      }
      case "form-list": {
        setView({ kind: "forms", title: "Forms", lines: formatFormsView(session.current) }, true);
        setStatus("Forms view");
        return;
      }
      case "form-submit": {
        const currentPage = session.current;
        if (!currentPage) {
          setStatus("No page loaded");
          return;
        }
        const forms = extractForms(currentPage.tree, currentPage.finalUrl);
        const form = forms[command.index - 1];
        if (!form) {
          setStatus(`No form at index ${String(command.index)}`);
          return;
        }
        const submission = buildFormSubmissionRequest(form, command.overrides);
        await navigateToTarget(submission.url, "text", submission.requestOptions);
        setStatus(`Submitted form [${String(command.index)}]`);
        return;
      }
      case "download": {
        const currentPage = session.current;
        if (!currentPage || !currentPage.sourceHtml) {
          setStatus("No HTML snapshot available for download");
          return;
        }
        await writeFile(command.path, currentPage.sourceHtml, "utf8");
        setStatus(`Saved ${String(currentPage.sourceHtml.length)} chars to ${command.path}`);
        return;
      }
      case "patch-remove-node": {
        const edits: readonly Edit[] = [{ kind: "removeNode", target: command.target }];
        const snapshot = session.applyEdits(edits);
        showPage(false);
        setStatus(`Patched page: remove node ${String(command.target)} (${String(snapshot.tree.errors.length)} parse errors)`);
        return;
      }
      case "patch-replace-text": {
        const edits: readonly Edit[] = [{ kind: "replaceText", target: command.target, value: command.value }];
        const snapshot = session.applyEdits(edits);
        showPage(false);
        setStatus(`Patched page: replace text on node ${String(command.target)} (${String(snapshot.tree.errors.length)} parse errors)`);
        return;
      }
      case "patch-set-attr": {
        const edits: readonly Edit[] = [{ kind: "setAttr", target: command.target, name: command.name, value: command.value }];
        const snapshot = session.applyEdits(edits);
        showPage(false);
        setStatus(`Patched page: set attr ${command.name} on node ${String(command.target)} (${String(snapshot.tree.errors.length)} parse errors)`);
        return;
      }
      case "patch-remove-attr": {
        const edits: readonly Edit[] = [{ kind: "removeAttr", target: command.target, name: command.name }];
        const snapshot = session.applyEdits(edits);
        showPage(false);
        setStatus(`Patched page: remove attr ${command.name} on node ${String(command.target)} (${String(snapshot.tree.errors.length)} parse errors)`);
        return;
      }
      case "patch-insert-before": {
        const edits: readonly Edit[] = [{ kind: "insertHtmlBefore", target: command.target, html: command.html }];
        const snapshot = session.applyEdits(edits);
        showPage(false);
        setStatus(`Patched page: insert before node ${String(command.target)} (${String(snapshot.tree.errors.length)} parse errors)`);
        return;
      }
      case "patch-insert-after": {
        const edits: readonly Edit[] = [{ kind: "insertHtmlAfter", target: command.target, html: command.html }];
        const snapshot = session.applyEdits(edits);
        showPage(false);
        setStatus(`Patched page: insert after node ${String(command.target)} (${String(snapshot.tree.errors.length)} parse errors)`);
        return;
      }
    }
  }

  async function promptAndRunCommand(): Promise<void> {
    promptActive = true;
    detachKeypressListener(keypressListener);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }

    try {
      const rawInput = await commandInterface.question("command> ");
      const command = parseCommand(rawInput);
      await executeCommand(command);
    } finally {
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      attachKeypressListener(keypressListener);
      promptActive = false;
      render();
    }
  }

  async function promptAndRunSearch(): Promise<void> {
    promptActive = true;
    detachKeypressListener(keypressListener);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }

    try {
      const query = await commandInterface.question("search> ");
      runSearch(query);
    } finally {
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      attachKeypressListener(keypressListener);
      promptActive = false;
      render();
    }
  }

  function enqueueAction(
    action: () => Promise<void> | void,
    options: { readonly allowWhenPromptActive?: boolean } = {}
  ): void {
    inputQueue = inputQueue.then(async () => {
      if (exiting) {
        return;
      }
      if (promptActive && options.allowWhenPromptActive !== true) {
        return;
      }

      try {
        await action();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Command failed: ${message}`);
      }

      render();
    });
  }

  function handleKeypress(character: string, key: KeyboardKey): void {
    if (promptActive || exiting) {
      return;
    }
    const shortcutAction = resolveShortcutAction(character, key);
    if (!shortcutAction) {
      return;
    }

    switch (shortcutAction.kind) {
      case "quit": {
        quit();
        return;
      }
      case "prompt": {
        promptActive = true;
        enqueueAction(promptAndRunCommand, { allowWhenPromptActive: true });
        return;
      }
      case "search-prompt": {
        promptActive = true;
        enqueueAction(promptAndRunSearch, { allowWhenPromptActive: true });
        return;
      }
      case "search-next": {
        enqueueAction(() => {
          moveSearch("next");
        });
        return;
      }
      case "search-prev": {
        enqueueAction(() => {
          moveSearch("prev");
        });
        return;
      }
      case "scroll-line-down": {
        enqueueAction(() => {
          pagerLineDown(pager);
        });
        return;
      }
      case "scroll-line-up": {
        enqueueAction(() => {
          pagerLineUp(pager);
        });
        return;
      }
      case "scroll-page-down": {
        enqueueAction(() => {
          pagerPageDown(pager);
        });
        return;
      }
      case "scroll-page-up": {
        enqueueAction(() => {
          pagerPageUp(pager);
        });
        return;
      }
      case "scroll-top": {
        enqueueAction(() => {
          pagerTop(pager);
        });
        return;
      }
      case "scroll-bottom": {
        enqueueAction(() => {
          pagerBottom(pager);
        });
        return;
      }
      case "show-page": {
        enqueueAction(() => {
          showPage(false);
          setStatus("Page view");
        });
        return;
      }
      case "run-command": {
        enqueueAction(async () => {
          await executeCommand(shortcutAction.command);
        });
        return;
      }
    }
  }

  const keypressListener = handleKeypress as KeypressListener;

  const initialTarget = process.argv[2] ?? store.latestHistoryUrl() ?? "about:help";

  try {
    await navigateToTarget(initialTarget);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setView({ kind: "help", title: "verge-browser help", lines: formatHelpText().split("\n") }, true);
    setStatus(`Initial navigation failed: ${message}`);
  }

  emitKeypressEvents(stdin);
  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  attachKeypressListener(keypressListener);
  process.on("SIGWINCH", handleResize);

  render();
  await exitPromise;

  detachKeypressListener(keypressListener);
  process.off("SIGWINCH", handleResize);
  if (stdin.isTTY) {
    stdin.setRawMode(false);
  }
  await inputQueue;
  commandInterface.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
