import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ShellServices } from "../ui/services.js";

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function csvText(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map((cell) => csvCell(cell)).join(",")).join("\n")}\n`;
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function runCommand(command: string, args: readonly string[], options: { readonly shell?: boolean; readonly stdio?: "ignore" | "inherit" } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: options.shell ?? false,
      stdio: options.stdio ?? "ignore"
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Command exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Command exited with status ${String(code)}`));
        return;
      }
      resolve();
    });
  });
}

function externalOpenCommand(target: string): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform === "darwin") {
    return {
      command: "open",
      args: [target]
    };
  }
  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "", target]
    };
  }
  return {
    command: "xdg-open",
    args: [target]
  };
}

export function createNodeShellServices(): ShellServices {
  return {
    async writeTextFile(path: string, content: string): Promise<void> {
      await writeTextFile(path, content);
    },
    async writeCsvFile(path: string, rows: readonly (readonly string[])[]): Promise<void> {
      await writeTextFile(path, csvText(rows));
    },
    async openExternal(target: string): Promise<void> {
      const command = externalOpenCommand(target);
      await runCommand(command.command, command.args);
    },
    async editTextExternally(initialText: string, label: string): Promise<string> {
      const editorCommand = process.env["VISUAL"] ?? process.env["EDITOR"];
      if (!editorCommand || editorCommand.trim().length === 0) {
        throw new Error("Set VISUAL or EDITOR before using the external editor.");
      }

      const tempDirectory = await mkdtemp(join(tmpdir(), "verge-browser-editor-"));
      const safeLabel = label.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "field";
      const tempPath = join(tempDirectory, `${safeLabel}.txt`);

      try {
        await writeFile(tempPath, initialText, "utf8");
        await runCommand(editorCommand, [tempPath], { shell: true, stdio: "inherit" });
        return await readFile(tempPath, "utf8");
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    }
  };
}
