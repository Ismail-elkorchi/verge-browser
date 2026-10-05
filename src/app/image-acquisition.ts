import { Buffer } from "node:buffer";
import type { DocumentImageResource, ImageFailureCode, IndexedWebDocumentSnapshot } from "../document/index.js";
import { StaticImageDecoder, type ImageDecoder } from "../runtime/image-decoder.js";
import { inspectImageHeader, ImageResourceError } from "./image-header.js";
import { imagePolicy, type ImagePolicyOptions } from "./image-policy.js";
import { NetworkFetchError } from "./fetch-page.js";
import type { FetchImageResult, IndexedPageSnapshot } from "./types.js";

export type ImageLoader = (requestUrl: string, documentUrl: string, options: {
  readonly signal: AbortSignal; readonly maxContentBytes: number; readonly maxRedirects: number; readonly timeoutMs: number;
}) => Promise<FetchImageResult>;
export interface ImageAcquisitionOptions {
  readonly signal: AbortSignal;
  readonly onResource: (resource: DocumentImageResource) => void | Promise<void>;
}
export interface ImageAcquisitionMetrics {
  readonly resources: number;
  readonly omittedReferences: number;
  readonly completed: number;
  readonly failed: number;
  /** Received bytes plus conservative full request reservations on transport failure. */
  readonly encodedBytes: number;
  readonly decodedBytes: number;
  readonly peakWorkspaceBytes: number;
  readonly peakConcurrency: number;
}
export interface DiscoveredDocumentImages {
  readonly resources: readonly DocumentImageResource[];
  /** Source-bearing img occurrences omitted by the resource-count limit, not unique URLs. */
  readonly omittedReferences: number;
}
function failed(image: DocumentImageResource, code: ImageFailureCode, reason: string): DocumentImageResource {
  return Object.freeze({ id: image.id, requestUrl: image.requestUrl, owners: image.owners,
    width: image.width, height: image.height, mimeType: image.mimeType, status: "failed", failure: code, reason });
}
/** Discover stable identities without fetching; ready/failed resources are resumable snapshot state. */
export function discoverDocumentImages(document: IndexedWebDocumentSnapshot, options: ImagePolicyOptions = {}): DiscoveredDocumentImages {
  const policy = imagePolicy(options);
  const grouped = new Map<string, { resource: DocumentImageResource; owners: DocumentImageResource["owners"][number][] }>();
  let omittedReferences = 0;
  for (const image of document.replacedContent) {
    if (image.kind !== "image" || image.source === null || image.source.length === 0) continue;
    const existing = grouped.get(image.source);
    if (existing !== undefined) {
      existing.owners.push(image.node);
      continue;
    }
    if (grouped.size >= policy.maxResources) {
      // Unlisted references retain canonical alternative text without inflating resource state.
      omittedReferences += 1;
      continue;
    }
    let resource: DocumentImageResource = Object.freeze({ id: image.source, requestUrl: image.source,
      owners: Object.freeze([image.node]), width: null, height: null, mimeType: null, status: "pending" });
    try {
      const protocol = new URL(image.source).protocol;
      if (protocol !== "http:" && protocol !== "https:" && protocol !== "data:") resource = failed(resource, "unsupported-protocol", "Only public HTTP(S) and bounded image data URLs are supported.");
    } catch { resource = failed(resource, "unsupported-protocol", "Invalid image URL."); }
    grouped.set(image.source, { resource, owners: [image.node] });
  }
  return Object.freeze({ omittedReferences,
    resources: Object.freeze([...grouped.values()].map(({ resource, owners }) => Object.freeze({ ...resource, owners: Object.freeze(owners) }))) });
}
function dataImage(requestUrl: string, maxBytes: number): FetchImageResult {
  // Limit the encoded string before substring, base64 decoding, or percent decoding.
  if (requestUrl.length > maxBytes * 4 + 128) throw new ImageResourceError("encoded-byte-limit", "Image data URL exceeds its byte budget.");
  const match = /^data:(image\/(?:png|jpeg));base64,([a-z0-9+/]*={0,2})$/iu.exec(requestUrl);
  if (match === null) throw new ImageResourceError("unsupported-format", "Only base64 PNG/JPEG image data URLs are supported.");
  const encoded = match[2] ?? "";
  const byteLength = (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (encoded.length % 4 !== 0 || byteLength > maxBytes) throw new ImageResourceError("encoded-byte-limit", "Image data URL exceeds its byte budget.");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== byteLength || bytes.toString("base64") !== encoded) throw new ImageResourceError("malformed-image", "Malformed image base64.");
  return { requestUrl, finalUrl: requestUrl, contentType: match[1]?.toLowerCase() ?? null, bytes };
}
function waitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason instanceof Error ? signal.reason : new Error("Image work cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : new Error(String(error))); });
  });
}
/** One bounded activation operation. The caller owns admission and backpressure. */
export async function acquireDocumentImages(snapshot: IndexedPageSnapshot, options: ImageAcquisitionOptions,
  loader: ImageLoader, policy: Required<ImagePolicyOptions>, createDecoder: () => ImageDecoder = () => new StaticImageDecoder(policy)
): Promise<ImageAcquisitionMetrics> {
  options.signal.throwIfAborted();
  const deadline = AbortSignal.timeout(policy.maxTotalMilliseconds);
  const deadlineExpired = (): boolean => policy.maxTotalMilliseconds === 0 || deadline.aborted;
  const signal = AbortSignal.any([options.signal, deadline]);
  const discovery = snapshot.images === undefined ? discoverDocumentImages(snapshot.document, policy)
    : { resources: snapshot.images, omittedReferences: snapshot.imageOmittedReferenceCount ?? 0 };
  const resources = discovery.resources;
  let completed = 0; let failures = 0; let encodedBytes = 0;
  let decodedBytes = resources.reduce((sum, resource) => sum + (resource.status === "ready" ? resource.pixels.byteLength : 0), 0);
  let peakWorkspaceBytes = 0; let peakConcurrency = 0;
  let decoder: ImageDecoder | null = null;
  let observerFailed = false;
  const observerRejected = (): boolean => observerFailed;
  const emit = async (resource: DocumentImageResource): Promise<void> => {
    signal.throwIfAborted();
    try { await waitWithSignal(Promise.resolve(options.onResource(resource)), signal); }
    catch (error) { observerFailed = true; throw error; }
    signal.throwIfAborted();
  };
  try {
    for (const original of resources) {
      options.signal.throwIfAborted();
      if (original.status !== "pending") continue;
      let resource = original;
      if (deadlineExpired()) { failures += 1; await emit(failed(resource, "timeout", "Image acquisition exceeded its total deadline.")); continue; }
      try {
        const remainingBytes = Math.min(policy.maxEncodedBytes, policy.maxTotalEncodedBytes - encodedBytes);
        if (remainingBytes <= 0) throw new ImageResourceError("encoded-byte-limit", "Aggregate encoded image byte budget exhausted.");
        if (policy.maxRequestMilliseconds === 0) throw new ImageResourceError("timeout", "Image request time budget is zero.");
        const timeout = AbortSignal.timeout(policy.maxRequestMilliseconds);
        const requestSignal = AbortSignal.any([signal, timeout]);
        // The HTTP failure contract does not expose consumed bytes. Reserve the full
        // allowance before starting and refund unused bytes only on bounded success.
        encodedBytes += remainingBytes;
        let fetched: FetchImageResult;
        if (resource.requestUrl.startsWith("data:")) fetched = dataImage(resource.requestUrl, remainingBytes);
        else {
          const target = new URL(resource.requestUrl);
          if (target.protocol !== "http:" && target.protocol !== "https:") throw new ImageResourceError("unsupported-protocol", "Unsupported image protocol.");
          fetched = await waitWithSignal(loader(resource.requestUrl, snapshot.finalUrl, { signal: requestSignal,
            maxContentBytes: remainingBytes, maxRedirects: policy.maxRedirects, timeoutMs: policy.maxRequestMilliseconds }), requestSignal);
          const final = new URL(fetched.finalUrl);
          if (final.protocol !== "http:" && final.protocol !== "https:") throw new ImageResourceError("unsupported-protocol", "Image redirect used an unsupported protocol.");
        }
        signal.throwIfAborted();
        if (fetched.bytes.byteLength > remainingBytes) throw new ImageResourceError("encoded-byte-limit", "Image loader exceeded its transport byte budget.");
        encodedBytes -= remainingBytes - fetched.bytes.byteLength;
        const header = inspectImageHeader(fetched.bytes, fetched.contentType, policy);
        resource = Object.freeze({ ...resource, width: header.width, height: header.height, mimeType: header.mimeType });
        await emit(resource);
        signal.throwIfAborted();
        if (decodedBytes + header.width * header.height * 4 > policy.maxTotalDecodedBytes) throw new ImageResourceError("pixel-limit", "Aggregate decoded image byte budget exhausted.");
        peakWorkspaceBytes = Math.max(peakWorkspaceBytes, header.workspaceBytes);
        peakConcurrency = 1;
        decoder ??= createDecoder();
        const pixels = await decoder.decode(fetched.bytes, header, signal);
        signal.throwIfAborted();
        if (pixels.byteLength !== header.width * header.height * 4) throw new ImageResourceError("decode-failed", "Decoder returned an unexpected pixel buffer.");
        for (let index = 3; index < pixels.byteLength; index += 4) {
          if (pixels[index] !== 255) throw new ImageResourceError("unsupported-alpha", "Transparent image pixels require backdrop compositing.");
        }
        decodedBytes += pixels.byteLength;
        await emit(Object.freeze({ ...resource, status: "ready", pixels }));
        completed += 1;
      } catch (error) {
        options.signal.throwIfAborted();
        if (observerRejected()) throw error;
        const code = error instanceof ImageResourceError ? error.code
          : deadlineExpired() || (error instanceof Error && error.name === "TimeoutError") ? "timeout"
          : error instanceof NetworkFetchError && error.networkOutcome.kind === "size_limit" ? "encoded-byte-limit" : "fetch-failed";
        failures += 1;
        await emit(failed(resource, code, error instanceof Error ? error.message : String(error)));
      }
    }
  } finally { await decoder?.close(); }
  options.signal.throwIfAborted();
  return Object.freeze({ resources: resources.length, omittedReferences: discovery.omittedReferences,
    completed, failed: failures, encodedBytes, decodedBytes, peakWorkspaceBytes, peakConcurrency });
}
