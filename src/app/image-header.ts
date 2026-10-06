import { inspectSvgHeader } from "./image-svg.js";
import type { ImageFailureCode } from "../document/image-resources.js";
import type { ImagePolicyOptions } from "./image-policy.js";

export class ImageResourceError extends Error {
  public readonly code: ImageFailureCode;
  public constructor(code: ImageFailureCode, message: string) { super(message); this.code = code; }
}
export interface ImageHeader {
  readonly mimeType: "image/png" | "image/jpeg" | "image/svg+xml";
  readonly width: number;
  readonly height: number;
  readonly workspaceBytes: number;
  readonly jpegColorTransform?: boolean;
  readonly encodedWidth?: number;
  readonly encodedHeight?: number;
  readonly orientation?: number;
}
function reject(message: string): never { throw new ImageResourceError("malformed-image", message); }
function oriented(header: ImageHeader, orientation: number): ImageHeader {
  return { ...header, encodedWidth: header.width, encodedHeight: header.height, orientation,
    width: orientation >= 5 ? header.height : header.width, height: orientation >= 5 ? header.width : header.height };
}
/** TIFF IFD0 only: offsets remain within this bounded EXIF segment, never external data. */
function exifOrientation(bytes: Uint8Array): number {
  if (bytes.byteLength < 8) reject("Truncated EXIF header.");
  const littleEndian = bytes[0] === 73 && bytes[1] === 73;
  if (!littleEndian && !(bytes[0] === 77 && bytes[1] === 77)) reject("Invalid EXIF byte order.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, littleEndian) !== 42) reject("Invalid EXIF TIFF marker.");
  const directory = view.getUint32(4, littleEndian);
  if (directory < 8 || directory + 2 > bytes.byteLength) reject("Invalid EXIF directory offset.");
  const count = view.getUint16(directory, littleEndian);
  if (directory + 2 + count * 12 + 4 > bytes.byteLength) reject("Truncated EXIF directory.");
  let orientation = 1; let found = false;
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12;
    if (view.getUint16(entry, littleEndian) !== 0x0112) continue;
    if (found || view.getUint16(entry + 2, littleEndian) !== 3 || view.getUint32(entry + 4, littleEndian) !== 1) reject("Invalid EXIF orientation field.");
    found = true;
    orientation = view.getUint16(entry + 8, littleEndian);
    if (orientation < 1 || orientation > 8) reject("Invalid EXIF orientation value.");
  }
  return orientation;
}
function size(width: number, height: number, bytes: number, policy: Required<ImagePolicyOptions>): number {
  if (width < 1 || height < 1) reject("Image dimensions must be positive.");
  if (width > policy.maxDimension || height > policy.maxDimension || width * height > policy.maxPixels) {
    throw new ImageResourceError("pixel-limit", "Image dimensions exceed the pixel budget.");
  }
  // Includes transport/decoder copies, output RGBA, 16-bit PNG temporaries and JPEG planes.
  const workspace = width * height * 64 + bytes * 4 + 1024 * 1024;
  if (workspace > policy.maxWorkspaceBytes) {
    throw new ImageResourceError("workspace-limit", "Image decode workspace exceeds its budget.");
  }
  return workspace;
}
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
  return value >>> 0;
});
function chunkCrc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ (CRC_TABLE[(value ^ byte) & 255] ?? 0);
  return (value ^ 0xffffffff) >>> 0;
}
function inspectPng(bytes: Uint8Array, policy: Required<ImagePolicyOptions>): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8; let header: ImageHeader | null = null; let dataSeen = false; let ended = false;
  let paletteSeen = false; let transparencySeen = false; let dataEnded = false;
  let orientation = 1; let exifSeen = false;
  let gammaSeen = false; let chromaticitySeen = false; let srgbSeen = false;
  let color = -1;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    if (length > bytes.byteLength - offset - 12) reject("Truncated PNG chunk.");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    // pngjs skips CRC validation for unrecognized ancillary chunks; validate the
    // entire bounded container here, including supported sRGB evidence.
    if (chunkCrc(bytes.subarray(offset + 4, start + length)) !== view.getUint32(start + length)) reject("Invalid PNG chunk checksum.");
    if (header === null && type !== "IHDR") reject("PNG must start with IHDR.");
    if (type === "IHDR") {
      if (header !== null || length !== 13) reject("Invalid or repeated PNG header.");
      const width = view.getUint32(start); const height = view.getUint32(start + 4);
      const depth = bytes[start + 8]; color = bytes[start + 9] ?? -1;
      const validDepths: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (depth === undefined || validDepths[color]?.includes(depth) !== true || bytes[start + 10] !== 0 || bytes[start + 11] !== 0) reject("Unsupported PNG header values.");
      if (bytes[start + 12] !== 0) throw new ImageResourceError("unsupported-interlace", "Interlaced PNG is not in the bounded decoder profile.");
      header = { mimeType: "image/png", width, height, workspaceBytes: size(width, height, bytes.byteLength, policy) };
    } else if (type === "PLTE") {
      if (paletteSeen || dataSeen || length === 0 || length > 768 || length % 3 !== 0) reject("Invalid PNG palette.");
      paletteSeen = true;
    } else if (type === "tRNS") {
      if (transparencySeen || dataSeen || (color === 3 && (!paletteSeen || length > 256))
        || (color === 0 && length !== 2) || (color === 2 && length !== 6)
        || (color !== 0 && color !== 2 && color !== 3)) reject("Invalid PNG transparency.");
      transparencySeen = true;
    } else if (type === "IDAT") {
      if (dataEnded) reject("PNG image data must be contiguous.");
      dataSeen = true;
    } else if (type === "IEND") {
      if (length !== 0 || !dataSeen || offset + 12 !== bytes.byteLength) reject("Invalid PNG image end.");
      ended = true; break;
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new ImageResourceError("unsupported-animation", "Animated PNG is not a static image.");
    } else if (type === "iCCP" || type === "cICP") {
      throw new ImageResourceError("unsupported-color-profile", "This PNG color profile is not supported.");
    } else if (type === "cHRM") {
      if (chromaticitySeen || paletteSeen || dataSeen || length !== 32) reject("Invalid or misplaced PNG chromaticity chunk.");
      chromaticitySeen = true;
      // Exact PNG sRGB chromaticities, in the integer units specified by PNG.
      // This admits canonical metadata without pretending to convert arbitrary profiles.
      const srgb = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
      if (srgb.some((value, index) => view.getUint32(start + index * 4) !== value)) {
        throw new ImageResourceError("unsupported-color-profile", "Non-sRGB PNG chromaticities are not supported.");
      }
    } else if (type === "gAMA") {
      if (gammaSeen || paletteSeen || dataSeen || length !== 4) reject("Invalid or misplaced PNG gamma chunk.");
      gammaSeen = true;
      if (view.getUint32(start) !== 45455) throw new ImageResourceError("unsupported-color-profile", "Non-sRGB PNG gamma is not supported.");
    } else if (type === "sRGB") {
      if (srgbSeen || paletteSeen || dataSeen || length !== 1 || (bytes[start] ?? 4) > 3) reject("Invalid or misplaced PNG sRGB chunk.");
      srgbSeen = true;
    } else if (type === "eXIf") {
      if (exifSeen) reject("Repeated PNG EXIF metadata.");
      exifSeen = true;
      orientation = exifOrientation(bytes.subarray(start, start + length));
    }
    if (dataSeen && type !== "IDAT") dataEnded = true;
    offset += length + 12;
  }
  if (header === null || !ended || (color === 3 && !paletteSeen)) reject("Incomplete PNG image.");
  return oriented(header, orientation);
}
function inspectJpeg(bytes: Uint8Array, policy: Required<ImagePolicyOptions>): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; let header: ImageHeader | null = null; let scanSeen = false;
  let adobeTransform: boolean | undefined;
  let rgbComponents = false;
  let orientation = 1; let exifSeen = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset++] !== 255) reject("Invalid JPEG marker.");
    while (bytes[offset] === 255) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0) reject("Invalid JPEG marker.");
    if (marker === 0xd9) {
      if (header === null || !scanSeen || offset !== bytes.byteLength) reject("Invalid JPEG image end.");
      return oriented({ ...header, jpegColorTransform: adobeTransform ?? !rgbComponents }, orientation);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.byteLength) reject("Truncated JPEG segment.");
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) reject("Truncated JPEG segment.");
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (header !== null || length < 8) reject("Invalid or repeated JPEG frame.");
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) throw new ImageResourceError("unsupported-format", "This JPEG coding mode is not supported.");
      const height = view.getUint16(offset + 3); const width = view.getUint16(offset + 5);
      const components = bytes[offset + 7] ?? 0;
      if (bytes[offset + 2] !== 8 || (components !== 1 && components !== 3) || length !== 8 + 3 * components) throw new ImageResourceError("unsupported-format", "Only 8-bit grayscale and RGB JPEG are supported.");
      rgbComponents = components === 3 && bytes[offset + 8] === 82 && bytes[offset + 11] === 71 && bytes[offset + 14] === 66;
      header = { mimeType: "image/jpeg", width, height, workspaceBytes: size(width, height, bytes.byteLength, policy) };
    }
    if (marker === 0xe2 && length >= 14 && String.fromCharCode(...bytes.subarray(offset + 2, offset + 14)) === "ICC_PROFILE\0") {
      throw new ImageResourceError("unsupported-color-profile", "JPEG ICC profiles are not supported.");
    }
    if (marker === 0xee && length >= 7 && String.fromCharCode(...bytes.subarray(offset + 2, offset + 7)) === "Adobe") {
      if (length !== 14 || adobeTransform !== undefined) reject("Invalid or repeated JPEG Adobe transform marker.");
      const transform = bytes[offset + 13];
      if (transform !== 0 && transform !== 1) throw new ImageResourceError("unsupported-color-profile", "This JPEG Adobe color transform is not supported.");
      adobeTransform = transform === 1;
    }
    if (marker === 0xe1 && length >= 8 && String.fromCharCode(...bytes.subarray(offset + 2, offset + 8)) === "Exif\0\0") {
      if (exifSeen) reject("Repeated JPEG EXIF metadata.");
      exifSeen = true;
      orientation = exifOrientation(bytes.subarray(offset + 8, offset + length));
    }
    offset += length;
    if (marker === 0xda) {
      if (header === null) reject("JPEG scan precedes its frame.");
      scanSeen = true;
      // Entropy bytes are not segments. Skip stuffed FF00 and restart markers,
      // then inspect every subsequent segment (including between progressive scans).
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 255) { offset += 1; continue; }
        const markerStart = offset;
        while (bytes[offset] === 255) offset += 1;
        const next = bytes[offset];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 1; continue; }
        offset = markerStart;
        break;
      }
    }
  }
  reject("JPEG has no image scan.");
}
/** Bounded structural/dimension preflight before any pixel decoder is invoked. */
export function inspectImageHeader(bytes: Uint8Array, contentType: string | null, policy: Required<ImagePolicyOptions>): ImageHeader {
  if (bytes.byteLength > policy.maxEncodedBytes) throw new ImageResourceError("encoded-byte-limit", "Encoded image exceeds its byte budget.");
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  let header: ImageHeader;
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) header = inspectPng(bytes, policy);
  else if (bytes[0] === 255 && bytes[1] === 216) header = inspectJpeg(bytes, policy);
  // SVG is never sniffed from HTML or an unknown media type. Its XML namespace and
  // active/external content are validated before any renderer is invoked.
  else if (type === "image/svg+xml") header = inspectSvgHeader(bytes, policy);
  else throw new ImageResourceError("unsupported-format", "Only static PNG, JPEG and bounded SVG are supported.");
  if (type !== undefined && type !== header.mimeType) throw new ImageResourceError("unsupported-format", "Image media type does not match its signature.");
  return Object.freeze(header);
}
