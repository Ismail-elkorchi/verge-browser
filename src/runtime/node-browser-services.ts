import { spawn } from "node:child_process";
import { link, mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";

import {
  HttpFields,
  mergeHttpFields,
  NodeHttpClient,
  parseContentLength
} from "@ismail-elkorchi/http-client";

import { navigationHttpSession } from "../app/http-session-context.js";
import type { BrowserServices, DownloadRequest, DownloadResult } from "../ui/services.js";

const DEFAULT_DOWNLOAD_RESPONSE_TIMEOUT_MS = 30_000;

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

export function externalOpenCommand(
  target: string,
  platform: NodeJS.Platform = process.platform
): { readonly command: string; readonly args: readonly string[] } {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [target]
    };
  }
  if (platform === "win32") {
    return {
      command: "explorer.exe",
      args: [target]
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
  if (cleaned.length === 0) return "download";
  let bounded = "";
  for (const character of cleaned) {
    const candidate = `${bounded}${character}`;
    if (Buffer.byteLength(candidate, "utf8") > 180) break;
    bounded = candidate;
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(bounded)) {
    return `_${bounded}`;
  }
  return bounded.length === 0 ? "download" : bounded;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function responseFileName(
  finalUrl: string,
  contentDisposition: string | null
): string {
  const disposition = contentDispositionFileName(contentDisposition);
  if (disposition) return safeFileName(disposition);
  const lastSegment = new URL(finalUrl).pathname.split("/").filter(Boolean).at(-1);
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

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null
    );
    if (result.bytesWritten < 1) {
      throw new Error("Download file write made no progress.");
    }
    offset += result.bytesWritten;
  }
}

async function downloadFile(
  client: NodeHttpClient,
  request: DownloadRequest,
  responseTimeoutMs: number
): Promise<DownloadResult> {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
    throw new RangeError("Download maxBytes must be a positive safe integer.");
  }
  request.signal?.throwIfAborted();
  if (
    Object.keys(request.headers ?? {})
      .some((name) => name.toLowerCase() === "cookie")
  ) {
    throw new TypeError(
      "Cookie fields are managed by the browser HTTP session."
    );
  }
  await mkdir(request.directory, { recursive: true });
  const fields = mergeHttpFields(
    new HttpFields([
      { name: "accept", value: "*/*" },
      { name: "user-agent", value: "verge-browser/0.2.0" }
    ]),
    request.headers === undefined
      ? undefined
      : Object.entries(request.headers).map(([name, value]) => ({
        name,
        value
      }))
  );
  const response = await client.fetch(request.url, {
    method: "GET",
    fields: fields.lines(),
    session: navigationHttpSession(request.session, request.sourceUrl)
      ?? request.session,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    timeouts: {
      totalMs: null,
      responseFieldsMs: responseTimeoutMs,
      responseBodyProgressMs: responseTimeoutMs
    },
    responseContentDecoding: "preserve",
    responseTransferLimits: {
      maxWireBytes: request.maxBytes,
      maxDecodedBytes: request.maxBytes
    }
  });
  if (response.kind === "failure") {
    throw response.error;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.cancel();
    await response.completion;
    throw new Error(
      `Download failed: ${String(response.statusCode)} ${response.statusMessage ?? ""}`
    );
  }
  const totalBytes = parseContentLength(
    response.fields.first("content-length")
  );
  if (totalBytes !== null && totalBytes > request.maxBytes) {
    response.cancel();
    await response.completion;
    throw new Error(`Download exceeds the ${String(request.maxBytes)} byte limit.`);
  }
  const fileName = responseFileName(
    response.finalUrl,
    response.fields.first("content-disposition")
  );
  const tempPath = join(
    request.directory,
    `.${fileName}.part-${String(process.pid)}-${crypto.randomUUID()}`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let receivedBytes = 0;
  try {
    handle = await open(tempPath, "wx");
    const reader = response.body.getReader();
    try {
      for (;;) {
        request.signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        receivedBytes += next.value.byteLength;
        await writeAll(handle, next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const completion = await response.completion;
    if (completion.kind === "failure") {
      throw completion.error;
    }
    if (completion.kind === "cancelled") {
      throw new Error("Download was cancelled.");
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    const path = await claimDestination(tempPath, request.directory, fileName);
    return { path, fileName: basename(path), receivedBytes, totalBytes };
  } catch (error) {
    response.cancel(error instanceof Error ? error : undefined);
    await response.completion;
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
}

export interface NodeBrowserServicesOptions {
  readonly downloadAddressPolicy?:
    | "public-only"
    | "allow-private-and-local";
  /** Maximum wait for response fields or additional response-body bytes. */
  readonly downloadResponseTimeoutMs?: number;
}

export function createNodeBrowserServices(
  options: NodeBrowserServicesOptions = {}
): BrowserServices {
  const responseTimeoutMs = options.downloadResponseTimeoutMs
    ?? DEFAULT_DOWNLOAD_RESPONSE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(responseTimeoutMs)
    || responseTimeoutMs < 1
    || responseTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      "downloadResponseTimeoutMs must be a positive safe integer no greater than 2147483647."
    );
  }
  const client = new NodeHttpClient(
    options.downloadAddressPolicy === "allow-private-and-local"
      ? {
        networkSafety: {
          allowLocalhost: true,
          allowPrivateNetworks: true
        }
      }
      : {}
  );
  return {
    async writeTextFile(path: string, content: string): Promise<void> {
      await writeTextFile(path, content);
    },
    async downloadFile(request): Promise<DownloadResult> {
      return downloadFile(client, request, responseTimeoutMs);
    },
    async openExternal(target: string): Promise<void> {
      const command = externalOpenCommand(target);
      await runCommand(command.command, command.args);
    },
    async openPath(path: string): Promise<void> {
      const command = externalOpenCommand(path);
      await runCommand(command.command, command.args);
    },
    async close(): Promise<void> {
      await client.close();
    }
  };
}
