import { Worker } from "node:worker_threads";
import { setTimeout, clearTimeout } from "node:timers";
import { ImageResourceError, type ImageHeader } from "../app/image-header.js";
import type { ImagePolicyOptions } from "../app/image-policy.js";
import type { ImageFailureCode } from "../document/image-resources.js";

export interface ImageDecodeRequest { readonly bytes: Uint8Array; readonly header: ImageHeader; readonly policy: Required<ImagePolicyOptions> }
export type ImageDecodeResponse = { readonly pixels: Uint8Array } | { readonly failure: ImageFailureCode; readonly reason: string };
export interface ImageDecoder {
  decode(bytes: Uint8Array, header: ImageHeader, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}
/** A serialized, operation-scoped decoder; termination bounds non-cooperative codec work. */
export class StaticImageDecoder implements ImageDecoder {
  readonly #policy: Required<ImagePolicyOptions>;
  #worker: Worker | null = null;
  #active = false;
  #closed = false;
  #terminating: Promise<void> = Promise.resolve();
  public constructor(policy: Required<ImagePolicyOptions>) { this.#policy = policy; }
  public async decode(bytes: Uint8Array, header: ImageHeader, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (this.#closed || this.#active) throw new Error("Image decoder is closed or already busy.");
    this.#active = true;
    try {
      await this.#terminating;
      signal.throwIfAborted();
      if (this.#isClosed()) throw new Error("Image decoder is closed.");
      const worker = this.#worker ??= new Worker(new URL("./image-decoder-entry.js", import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: Math.max(16, Math.ceil(this.#policy.maxWorkspaceBytes / (1024 * 1024))) }
      });
      const pixels = await new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | null, pixels?: Uint8Array): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          worker.off("message", message); worker.off("error", failed); worker.off("exit", exited);
          if (error !== null) reject(error); else if (pixels !== undefined) resolve(pixels);
        };
        const stop = (error: Error): void => { finish(error); this.#terminate(worker); };
        const abort = (): void => { stop(signal.reason instanceof Error ? signal.reason : new Error("Image decoding cancelled.")); };
        const failed = (error: Error): void => { stop(new ImageResourceError("decode-failed", error.message)); };
        const exited = (code: number): void => { stop(new ImageResourceError("decode-failed", `Image decoder exited with ${String(code)}.`)); };
        const message = (response: ImageDecodeResponse): void => {
          if ("failure" in response) {
            const error = new ImageResourceError(response.failure, response.reason);
            // A codec/WASM trap can leave allocator state unusable. The next serialized
            // resource gets a fresh worker after termination, never a poisoned instance.
            if (response.failure === "decode-failed") stop(error); else finish(error);
          } else finish(null, response.pixels);
        };
        const timer = setTimeout(() => { stop(new ImageResourceError("timeout", "Image decoding exceeded its deadline.")); }, this.#policy.maxDecodeMilliseconds);
        signal.addEventListener("abort", abort, { once: true });
        worker.on("message", message); worker.once("error", failed); worker.once("exit", exited);
        // The transport buffer is not retained in the immutable page snapshot. Transfer
        // an owned view so pooled Buffers/custom loaders cannot detach unrelated data.
        try {
          const owned = new Uint8Array(bytes);
          worker.postMessage({ bytes: owned, header, policy: this.#policy } satisfies ImageDecodeRequest, [owned.buffer]);
        } catch (error) { stop(new ImageResourceError("decode-failed", error instanceof Error ? error.message : String(error))); }
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      if (this.#isClosed()) throw new Error("Image decoder is closed.");
      return pixels;
    } finally { this.#active = false; }
  }
  #isClosed(): boolean { return this.#closed; }
  #terminate(worker: Worker): void {
    if (this.#worker !== worker) return;
    this.#worker = null;
    this.#terminating = worker.terminate().then(() => undefined);
  }
  public async close(): Promise<void> {
    this.#closed = true;
    if (this.#worker !== null) this.#terminate(this.#worker);
    await this.#terminating;
  }
}
