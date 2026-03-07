import type { KeyboardKey } from "../app/types.js";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface CursorPosition {
  readonly row: number;
  readonly column: number;
}

export type TerminalKeyListener = (character: string, key: KeyboardKey) => void;
export type TerminalResizeListener = (size: TerminalSize) => void;

/**
 * Thin runtime boundary for interactive terminal I/O.
 *
 * The shell core depends on this interface instead of `node:process`,
 * `node:readline`, or runtime-specific globals directly.
 */
export interface TerminalAdapter {
  getSize(): TerminalSize;
  clearScreen(): void;
  write(text: string): void;
  moveCursor(position: CursorPosition): void;
  hideCursor(): void;
  showCursor(): void;
  setRawMode(enabled: boolean): void;
  onKeypress(listener: TerminalKeyListener): () => void;
  onResize(listener: TerminalResizeListener): () => void;
  dispose(): void;
}
