import { parentPort } from "node:worker_threads";
import { PNG } from "pngjs";
import { decode } from "jpeg-js";
import { inspectImageHeader, ImageResourceError } from "../app/image-header.js";
import type { ImageDecodeRequest, ImageDecodeResponse } from "./image-decoder.js";

const port = parentPort;
if (port === null) throw new Error("Image decoder requires a worker message port.");
port.on("message", (request: ImageDecodeRequest) => {
  try {
    // Repeat the allocation fence at the worker boundary; never trust transferred metadata.
    const header = inspectImageHeader(request.bytes, request.header.mimeType, request.policy);
    if (header.width !== request.header.width || header.height !== request.header.height) {
      throw new ImageResourceError("malformed-image", "Image header changed before decoding.");
    }
    const result = header.mimeType === "image/png"
      ? PNG.sync.read(Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength), { checkCRC: true })
      : decode(request.bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
        colorTransform: header.jpegColorTransform ?? true,
        maxResolutionInMP: request.policy.maxPixels / 1_000_000,
        maxMemoryUsageInMB: Math.max(1, (header.workspaceBytes - request.bytes.byteLength * 4) / (1024 * 1024)) });
    if (result.width !== (header.encodedWidth ?? header.width) || result.height !== (header.encodedHeight ?? header.height) || result.data.byteLength !== header.width * header.height * 4) {
      throw new ImageResourceError("malformed-image", "Decoded dimensions do not match image metadata.");
    }
    for (let index = 3; index < result.data.byteLength; index += 4) {
      if (result.data[index] !== 255) throw new ImageResourceError("unsupported-alpha", "Transparent images require backdrop compositing and use their alternative text.");
    }
    // The same mandatory owned output copy also applies EXIF orientation. No second
    // orientation buffer is allocated; this RGBA copy is included in the workspace fence.
    const pixels = new Uint8Array(result.data.byteLength);
    const orientation = header.orientation ?? 1;
    if (orientation === 1) pixels.set(result.data);
    else for (let y = 0; y < result.height; y += 1) {
      for (let x = 0; x < result.width; x += 1) {
        const targetX = orientation === 2 || orientation === 3 ? result.width - 1 - x
          : orientation === 5 || orientation === 8 ? y : orientation === 6 || orientation === 7 ? result.height - 1 - y : x;
        const targetY = orientation === 3 || orientation === 4 ? result.height - 1 - y
          : orientation === 5 || orientation === 6 ? x : orientation === 7 || orientation === 8 ? result.width - 1 - x : y;
        const source = (y * result.width + x) * 4;
        const target = (targetY * header.width + targetX) * 4;
        pixels[target] = result.data[source] ?? 0;
        pixels[target + 1] = result.data[source + 1] ?? 0;
        pixels[target + 2] = result.data[source + 2] ?? 0;
        pixels[target + 3] = 255;
      }
    }
    port.postMessage({ pixels } satisfies ImageDecodeResponse, [pixels.buffer]);
  } catch (error) {
    port.postMessage({ failure: error instanceof ImageResourceError ? error.code : "decode-failed",
      reason: error instanceof Error ? error.message : String(error) } satisfies ImageDecodeResponse);
  }
});
