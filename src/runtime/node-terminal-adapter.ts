import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";

import type {
  CursorPosition,
  TerminalAdapter,
  TerminalKeyListener,
  TerminalResizeListener,
  TerminalSize
} from "../ui/terminal-adapter.js";

function clampColumns(columns: number | undefined): number {
  if (!columns || !Number.isFinite(columns)) {
    return 100;
  }
  return Math.max(40, columns);
}

function clampRows(rows: number | undefined): number {
  if (!rows || !Number.isFinite(rows)) {
    return 30;
  }
  return Math.max(10, rows);
}

export function createNodeTerminalAdapter(): TerminalAdapter {
  emitKeypressEvents(stdin);

  return {
    getSize(): TerminalSize {
      return {
        columns: clampColumns(stdout.columns),
        rows: clampRows(stdout.rows)
      };
    },
    clearScreen(): void {
      stdout.write("\u001b[2J\u001b[H");
    },
    write(text: string): void {
      stdout.write(text);
    },
    moveCursor(position: CursorPosition): void {
      stdout.write(`\u001b[${String(position.row)};${String(position.column)}H`);
    },
    hideCursor(): void {
      stdout.write("\u001b[?25l");
    },
    showCursor(): void {
      stdout.write("\u001b[?25h");
    },
    setRawMode(enabled: boolean): void {
      if (stdin.isTTY) {
        stdin.setRawMode(enabled);
      }
    },
    onKeypress(listener: TerminalKeyListener): () => void {
      stdin.on("keypress", listener);
      return () => {
        stdin.off("keypress", listener);
      };
    },
    onResize(listener: TerminalResizeListener): () => void {
      const handleResize = (): void => {
        listener({
          columns: clampColumns(stdout.columns),
          rows: clampRows(stdout.rows)
        });
      };
      process.on("SIGWINCH", handleResize);
      return () => {
        process.off("SIGWINCH", handleResize);
      };
    },
    dispose(): void {
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdout.write("\u001b[?25h");
    }
  };
}
