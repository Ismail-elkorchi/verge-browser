import type { DocumentNodeRef } from "./types.js";

/** Stable source identity and natural dimensions; independent of pixel readiness. */
export interface DocumentImageMetadata {
  readonly id: string;
  readonly requestUrl: string;
  readonly owners: readonly DocumentNodeRef[];
  readonly width: number | null;
  readonly height: number | null;
}

export type ImageFailureCode = "unsupported-protocol" | "unsupported-format" | "unsupported-animation"
  | "unsupported-interlace" | "unsupported-color-profile" | "unsupported-alpha" | "malformed-image"
  | "resource-limit" | "encoded-byte-limit" | "pixel-limit" | "workspace-limit"
  | "fetch-failed" | "decode-failed" | "acquisition-failed" | "timeout";

/** Pixels are owned by the accepted page snapshot, never by a separate resource cache. */
export type DocumentImageResource = DocumentImageMetadata & {
  readonly mimeType: "image/png" | "image/jpeg" | null;
} & ({ readonly status: "pending" }
  | { readonly status: "ready";
      /** Owned packed RGBA8, exactly width × height × 4 bytes; every alpha byte is 255.
       * Admission validates opacity in the decoder and again at the acquisition boundary. */
      readonly pixels: Uint8Array }
  | { readonly status: "failed"; readonly failure: ImageFailureCode; readonly reason: string });

/** Metadata-only boundary used by layout and the rendering worker. */
export function documentImageMetadata(image: DocumentImageMetadata): DocumentImageMetadata {
  return Object.freeze({ id: image.id, requestUrl: image.requestUrl, owners: image.owners,
    width: image.width, height: image.height });
}
