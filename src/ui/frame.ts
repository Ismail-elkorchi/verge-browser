import { activeSearchLineIndex } from "../app/search.js";
import type { PageSnapshot } from "../app/types.js";
import type { CursorPosition, TerminalSize } from "./terminal-adapter.js";
import type {
  DetailState,
  DocumentViewState,
  EditorFieldState,
  EditorState,
  PaletteMode,
  PaletteState,
  PickerItem,
  PickerState,
  ShellState
} from "./types.js";

export interface ShellFrame {
  readonly text: string;
  readonly cursor: CursorPosition | null;
}

interface BodyRenderResult {
  readonly lines: readonly string[];
  readonly cursor: CursorPosition | null;
}

function fitLine(rawText: string, width: number): string {
  if (width <= 0) return "";
  if (rawText.length <= width) return rawText;
  if (width <= 1) return rawText.slice(0, width);
  return `${rawText.slice(0, width - 1)}…`;
}

function viewportStart(selectedIndex: number, itemCount: number, visibleCount: number): number {
  if (itemCount <= visibleCount) {
    return 0;
  }
  const centered = selectedIndex - Math.floor(visibleCount / 2);
  return Math.max(0, Math.min(centered, itemCount - visibleCount));
}

function currentDocument(state: ShellState): DocumentViewState | null {
  return state.documents[state.activeDocumentIndex] ?? null;
}

function currentSnapshot(documentState: DocumentViewState | null): PageSnapshot | null {
  return documentState?.snapshot ?? null;
}

function currentScreenLabel(state: ShellState): string {
  switch (state.screen) {
    case "browse":
      return "Browse";
    case "picker":
      return state.picker?.title ?? "Picker";
    case "palette":
      return state.palette?.mode === "location"
        ? "Location"
        : state.palette?.mode === "search"
          ? "Find"
          : "Actions";
    case "editor":
      return state.editor?.title ?? "Editor";
    case "detail":
      return state.detail?.title ?? "Detail";
  }
}

function defaultStatusText(state: ShellState): string {
  const documentState = currentDocument(state);
  if (state.status) {
    return state.status.text;
  }

  if (state.screen === "browse") {
    if (!documentState?.rendered) {
      return "Open a page with g, or press ? for help.";
    }
    const actionCount = documentState.rendered.actionables.length;
    const focusLabel = documentState.focusMode === "link-control"
      ? `link/control focus${documentState.linkControlFocus ? ` ${String(documentState.linkControlFocus.actionableIndex + 1)}/${String(actionCount)}` : ""}`
      : "reading focus";
    const searchState = documentState.search?.state;
    if (searchState && searchState.matchLineIndices.length > 0) {
      return `${focusLabel} | find ${String(searchState.activeMatchIndex + 1)}/${String(searchState.matchLineIndices.length)} "${searchState.query}"`;
    }
    if (searchState && searchState.query.length > 0) {
      return `${focusLabel} | no matches for "${searchState.query}"`;
    }
    return `${focusLabel} | ${String(actionCount)} page action${actionCount === 1 ? "" : "s"}`;
  }

  if (state.screen === "picker" && state.picker) {
    const itemCount = state.picker.items.length;
    const selectionText = itemCount === 0
      ? "no items"
      : `focus ${String(state.picker.selectedIndex + 1)} of ${String(itemCount)}`;
    return `${state.picker.title}, ${String(itemCount)} item${itemCount === 1 ? "" : "s"}, ${selectionText}`;
  }

  if (state.screen === "palette" && state.palette) {
    if (state.palette.mode === "search") {
      return "Type a find query and press Enter. Esc returns to browsing.";
    }
    if (state.palette.mode === "location") {
      return "Type a URL or relative target, then press Enter.";
    }
    return "Type an action such as links, documents, diag, bookmark add, or save text.";
  }

  if (state.screen === "editor") {
    return "Edit fields, submit with s, open the external editor with x, or cancel with Esc.";
  }

  if (state.screen === "detail") {
    return "Use Up/Down or page keys to read, then Esc to return.";
  }

  return "Ready.";
}

function footerText(state: ShellState): string {
  switch (state.screen) {
    case "browse":
      return "Up/Down scroll  [/] move links  Enter open  g location  : actions  / find  h/f/r nav  D docs  ? help  q quit";
    case "picker":
      return "Up/Down move  Enter open  / filter  digits jump  Tab filter/list  Esc back";
    case "palette": {
      const mode = state.palette?.mode;
      if (mode === "search") {
        return "Type query  Enter run  Backspace edit  Esc back";
      }
      return "Type input  Enter run  Up/Down suggestions  Backspace edit  Esc back";
    }
    case "editor":
      return state.editor?.mode === "edit"
        ? "Type text  Tab next field  Esc stop editing"
        : "Enter edit  Tab next field  s submit  d discard  x external  Esc back";
    case "detail":
      return "Up/Down scroll  PageUp/PageDown move  Esc back";
  }
}

function contextText(state: ShellState): string {
  const documentState = currentDocument(state);
  const snapshot = currentSnapshot(documentState);
  const documentCount = state.documents.length;
  const documentLabel = documentCount === 0
    ? "doc 0/0"
    : `doc ${String(state.activeDocumentIndex + 1)}/${String(documentCount)}`;
  const screenLabel = currentScreenLabel(state);

  if (!snapshot) {
    return fitLine(`${screenLabel} | ${documentLabel} | no page loaded`, 10_000);
  }

  const actionCount = documentState?.rendered?.actionables.length ?? 0;
  const focusLabel = documentState?.focusMode === "link-control" ? "link/control" : "reading";
  return fitLine(
    `${screenLabel} | ${documentLabel} | ${String(snapshot.status)} ${snapshot.statusText} | ${focusLabel} | ${String(actionCount)} actions | ${snapshot.finalUrl}`,
    10_000
  );
}

function renderBrowseBody(documentState: DocumentViewState | null, size: TerminalSize, chromeLineCount: number): BodyRenderResult {
  const bodyHeight = Math.max(1, size.rows - chromeLineCount);
  if (!documentState?.rendered) {
    return {
      lines: ["No page loaded."],
      cursor: null
    };
  }

  const allLines = documentState.rendered.lines;
  const focusLineIndex = documentState.focusMode === "link-control"
    ? documentState.rendered.actionables[documentState.linkControlFocus?.actionableIndex ?? -1]?.lineIndex ?? null
    : null;
  const searchLineIndex = documentState.search ? activeSearchLineIndex(documentState.search.state) : null;
  const preferredLineIndex = focusLineIndex ?? searchLineIndex ?? documentState.scrollOffset;
  const startLineIndex = Math.max(
    0,
    Math.min(
      preferredLineIndex,
      Math.max(0, allLines.length - bodyHeight)
    )
  );
  const viewportLines = allLines.slice(startLineIndex, startLineIndex + bodyHeight);
  const renderedLines = viewportLines.map((line, index) => {
    const lineIndex = startLineIndex + index;
    let marker = " ";
    if (focusLineIndex === lineIndex && searchLineIndex === lineIndex) {
      marker = "*";
    } else if (focusLineIndex === lineIndex) {
      marker = ">";
    } else if (searchLineIndex === lineIndex) {
      marker = "/";
    }
    return `${marker} ${fitLine(line, Math.max(1, size.columns - 2))}`;
  });

  const cursor = focusLineIndex !== null
    && focusLineIndex >= startLineIndex
    && focusLineIndex < startLineIndex + renderedLines.length
    ? {
      row: chromeLineCount + (focusLineIndex - startLineIndex) + 1,
      column: 1
    }
    : null;

  return {
    lines: renderedLines.length > 0 ? renderedLines : ["(no content)"],
    cursor
  };
}

function renderPickerBody(picker: PickerState | null, size: TerminalSize, chromeLineCount: number): BodyRenderResult {
  if (!picker) {
    return {
      lines: ["No picker data."],
      cursor: null
    };
  }

  const bodyHeight = Math.max(1, size.rows - chromeLineCount);
  const prefaceLines: string[] = [];
  let cursor: CursorPosition | null = null;

  if (picker.filterText.length > 0 || picker.focusTarget === "filter") {
    const filterLine = `Filter: ${picker.filterText}`;
    prefaceLines.push(fitLine(filterLine, size.columns));
    if (picker.focusTarget === "filter") {
      cursor = {
        row: chromeLineCount + prefaceLines.length,
        column: Math.min(size.columns, "Filter: ".length + picker.filterText.length + 1)
      };
    }
  }

  if (picker.jumpText.length > 0) {
    prefaceLines.push(fitLine(`Jump: ${picker.jumpText}`, size.columns));
  }

  const listHeight = Math.max(1, bodyHeight - prefaceLines.length);
  const startIndex = viewportStart(picker.selectedIndex, picker.items.length, listHeight);
  const visibleItems = picker.items.slice(startIndex, startIndex + listHeight);
  const listLines = visibleItems.map((item, index) => renderPickerItemLine(
    item,
    startIndex + index === picker.selectedIndex,
    size.columns
  ));

  if (!cursor && picker.items.length > 0 && picker.focusTarget === "list") {
    const rowOffset = picker.selectedIndex - startIndex;
    if (rowOffset >= 0 && rowOffset < listLines.length) {
      cursor = {
        row: chromeLineCount + prefaceLines.length + rowOffset + 1,
        column: 1
      };
    }
  }

  return {
    lines: [...prefaceLines, ...(listLines.length > 0 ? listLines : ["No items."])],
    cursor
  };
}

function renderPickerItemLine(item: PickerItem, selected: boolean, width: number): string {
  const prefix = selected ? ">" : " ";
  const detail = item.detail ? ` - ${item.detail}` : "";
  return fitLine(`${prefix} [${String(item.index)}] ${item.label}${detail}`, width);
}

function paletteTitle(mode: PaletteMode): string {
  switch (mode) {
    case "location":
      return "Location";
    case "action":
      return "Action";
    case "search":
      return "Find";
  }
}

function renderPaletteBody(palette: PaletteState | null, size: TerminalSize, chromeLineCount: number): BodyRenderResult {
  if (!palette) {
    return {
      lines: ["No palette input."],
      cursor: null
    };
  }

  const bodyHeight = Math.max(1, size.rows - chromeLineCount);
  const lines: string[] = [
    fitLine(`${paletteTitle(palette.mode)}:`, size.columns),
    fitLine(`> ${palette.inputText}`, size.columns)
  ];

  if (palette.repairText) {
    lines.push(fitLine(`Hint: ${palette.repairText}`, size.columns));
  }

  const availableSuggestionRows = Math.max(0, bodyHeight - lines.length);
  if (availableSuggestionRows > 0) {
    const startIndex = viewportStart(palette.selectedSuggestionIndex, palette.suggestions.length, availableSuggestionRows);
    const visibleSuggestions = palette.suggestions.slice(startIndex, startIndex + availableSuggestionRows);
    lines.push(
      ...visibleSuggestions.map((suggestion, index) => {
        const isSelected = startIndex + index === palette.selectedSuggestionIndex;
        const prefix = isSelected ? ">" : " ";
        const description = suggestion.description ? ` - ${suggestion.description}` : "";
        return fitLine(`${prefix} ${suggestion.value}${description}`, size.columns);
      })
    );
  }

  return {
    lines,
    cursor: {
      row: chromeLineCount + 2,
      column: Math.min(size.columns, palette.inputText.length + 3)
    }
  };
}

function renderDetailBody(detail: DetailState | null, size: TerminalSize, chromeLineCount: number): BodyRenderResult {
  if (!detail) {
    return {
      lines: ["No detail content."],
      cursor: null
    };
  }

  const bodyHeight = Math.max(1, size.rows - chromeLineCount);
  const startLineIndex = Math.max(0, Math.min(detail.scrollOffset, Math.max(0, detail.lines.length - bodyHeight)));

  return {
    lines: detail.lines.slice(startLineIndex, startLineIndex + bodyHeight).map((line) => fitLine(line, size.columns)),
    cursor: null
  };
}

function renderEditorBody(editor: EditorState | null, size: TerminalSize, chromeLineCount: number): BodyRenderResult {
  if (!editor) {
    return {
      lines: ["No editor state."],
      cursor: null
    };
  }

  const lines: string[] = [];
  let cursor: CursorPosition | null = null;

  for (const [fieldIndex, field] of editor.fields.entries()) {
    const selected = fieldIndex === editor.selectedFieldIndex;
    const marker = selected ? ">" : " ";
    const fieldLines = renderEditorField(field, marker, size.columns);
    const fieldStartRow = chromeLineCount + lines.length + 1;
    lines.push(...fieldLines);

    if (selected && editor.mode !== "confirm-exit" && cursor === null) {
      if (editor.mode === "edit") {
        cursor = editorCursorForField(field, fieldStartRow, editor.cursorOffset, size.columns);
      } else {
        cursor = {
          row: fieldStartRow,
          column: 1
        };
      }
    }
  }

  if (editor.mode === "confirm-exit") {
    lines.push("");
    lines.push(fitLine("Unsaved changes. Press s to submit, d to discard, or Esc to keep editing.", size.columns));
  }

  return {
    lines: lines.length > 0 ? lines : ["No editable fields."],
    cursor
  };
}

function renderEditorField(field: EditorFieldState, marker: string, width: number): readonly string[] {
  const header = fitLine(`${marker} ${field.label}:`, width);
  const valueLines = field.value.length > 0 ? field.value.split("\n") : [""];
  return [
    header,
    ...valueLines.map((line) => fitLine(`  ${line}`, width))
  ];
}

function editorCursorForField(field: EditorFieldState, startRow: number, cursorOffset: number, width: number): CursorPosition {
  const safeOffset = Math.max(0, Math.min(cursorOffset, field.value.length));
  const beforeCursor = field.value.slice(0, safeOffset).split("\n");
  const rowOffset = Math.max(0, beforeCursor.length - 1);
  const currentLine = beforeCursor[beforeCursor.length - 1] ?? "";
  return {
    row: startRow + 1 + rowOffset,
    column: Math.min(width, currentLine.length + 3)
  };
}

export function renderShellFrame(state: ShellState, size: TerminalSize): ShellFrame {
  const titleRow = fitLine(`verge-browser | ${currentScreenLabel(state)}`, size.columns);
  const contextRow = fitLine(contextText(state), size.columns);
  const statusRow = fitLine(defaultStatusText(state), size.columns);
  const footerRow = fitLine(footerText(state), size.columns);
  const chromeLines = [titleRow, contextRow, statusRow, footerRow];

  let body: BodyRenderResult;
  switch (state.screen) {
    case "browse":
      body = renderBrowseBody(currentDocument(state), size, chromeLines.length);
      break;
    case "picker":
      body = renderPickerBody(state.picker, size, chromeLines.length);
      break;
    case "palette":
      body = renderPaletteBody(state.palette, size, chromeLines.length);
      break;
    case "editor":
      body = renderEditorBody(state.editor, size, chromeLines.length);
      break;
    case "detail":
      body = renderDetailBody(state.detail, size, chromeLines.length);
      break;
  }

  return {
    text: [...chromeLines, ...body.lines.map((line) => fitLine(line, size.columns))].join("\n"),
    cursor: body.cursor
  };
}
