import { spawn } from "node:child_process";
import { link, mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";

import type { BrowserServices, DownloadRequest, DownloadResult } from "../ui/services.js";

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

function contentDispositionFileName(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return /filename="?([^";]+)"?/iu.exec(value)?.[1] ?? null;
}

function safeFileName(value: string): string {
  const cleaned = basename(value)
    .replaceAll(/[\u0000-\u001F\u007F<>:"/\\|?*]+/gu, "-")
    .replaceAll(/^\.+|\.+$/gu, "")
    .trim();
  return cleaned.length === 0 ? "download" : cleaned.slice(0, 180);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function responseFileName(response: Response): string {
  const disposition = contentDispositionFileName(response.headers.get("content-disposition"));
  if (disposition) return safeFileName(disposition);
  const lastSegment = new URL(response.url).pathname.split("/").filter(Boolean).at(-1);
  return safeFileName(lastSegment ? decodePathSegment(lastSegment) : "download");
}

async function claimDestination(tempPath: string, directory: string, fileName: string): Promise<string> {
  const parts = parse(fileName);
  for (let index = 0; index < 10_000; index += 1) {
    const candidateName = index === 0
      ? fileName
      : `${parts.name} (${String(index)})${parts.ext}`;
    const candidate = join(directory, candidateName);
    try {
      await link(tempPath, candidate);
      await unlink(tempPath);
      return candidate;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not choose a free destination for ${fileName}.`);
}

async function downloadFile(request: DownloadRequest): Promise<DownloadResult> {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
    throw new RangeError("Download maxBytes must be a positive safe integer.");
  }
  request.signal?.throwIfAborted();
  await mkdir(request.directory, { recursive: true });
  const response = await fetch(request.url, {
    redirect: "follow",
    ...(request.headers === undefined ? {} : { headers: request.headers }),
    ...(request.signal === undefined ? {} : { signal: request.signal })
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${String(response.status)} ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null;
  if (totalBytes !== null && totalBytes > request.maxBytes) {
    throw new Error(`Download exceeds the ${String(request.maxBytes)} byte limit.`);
  }
  const fileName = responseFileName(response);
  const tempPath = join(
    request.directory,
    `.${fileName}.part-${String(process.pid)}-${crypto.randomUUID()}`
  );
  const handle = await open(tempPath, "wx");
  let receivedBytes = 0;
  try {
    const reader = response.body.getReader();
    try {
      for (;;) {
        request.signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        receivedBytes += next.value.byteLength;
        if (receivedBytes > request.maxBytes) {
          await reader.cancel("Download size limit exceeded.");
          throw new Error(`Download exceeds the ${String(request.maxBytes)} byte limit.`);
        }
        await handle.write(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    await handle.sync();
    await handle.close();
    const path = await claimDestination(tempPath, request.directory, fileName);
    return { path, fileName: basename(path), receivedBytes, totalBytes };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
}

export function createNodeBrowserServices(): BrowserServices {
  return {
    async writeTextFile(path: string, content: string): Promise<void> {
      await writeTextFile(path, content);
    },
    downloadFile,
    async openExternal(target: string): Promise<void> {
      const command = externalOpenCommand(target);
      await runCommand(command.command, command.args);
    },
    async openPath(path: string): Promise<void> {
      const command = externalOpenCommand(path);
      await runCommand(command.command, command.args);
    },
  };
}
