import type { DocumentNodeRef } from "./types.js";

/** Stable source identity and natural dimensions; independent of pixel readiness. */
export interface DocumentImageMetadata {
  readonly id: string;
  readonly requestUrl: string;
  readonly owners: readonly DocumentNodeRef[];
  readonly width: number | null;
  readonly height: number | null;
  /** Known only after pixel decode; alpha changes affect paint, not intrinsic layout. */
  readonly hasAlpha: boolean | null;
  /** Terminal acquisition failure affects artwork diagnostics, never pixel ownership. */
  readonly failure?: ImageFailureCode;
}

export type ImageFailureCode = "unsupported-protocol" | "unsupported-format" | "unsupported-animation"
  | "unsupported-interlace" | "unsupported-color-profile" | "malformed-image"
  | "resource-limit" | "encoded-byte-limit" | "pixel-limit" | "workspace-limit"
  | "fetch-failed" | "decode-failed" | "acquisition-failed" | "timeout";

/** Pixels are owned by the accepted page snapshot, never by a separate resource cache. */
export type DocumentImageResource = DocumentImageMetadata & {
  readonly mimeType: "image/png" | "image/jpeg" | "image/svg+xml" | null;
} & ({ readonly status: "pending" }
  | { readonly status: "ready";
      readonly hasAlpha: boolean;
      /** Owned packed straight (unassociated) sRGB RGBA8, exactly width × height × 4 bytes.
       * Alpha is preserved. Presentation separately admits opaque pixels or composites
       * against a verified backdrop; readiness alone never authorizes terminal output. */
      readonly pixels: Uint8Array }
  | { readonly status: "failed"; readonly failure: ImageFailureCode; readonly reason: string });

/** Metadata-only boundary used by layout and the rendering worker. */
export function documentImageMetadata(image: DocumentImageMetadata): DocumentImageMetadata {
  return Object.freeze({ id: image.id, requestUrl: image.requestUrl, owners: image.owners,
    width: image.width, height: image.height, hasAlpha: image.hasAlpha,
    ...(image.failure === undefined ? {} : { failure: image.failure }) });
}
