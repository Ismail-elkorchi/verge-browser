import { readFile } from "node:fs/promises";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { ImageResourceError, type ImageHeader } from "../app/image-header.js";

let initialized: Promise<void> | undefined;
/** The WASM asset is an explicit package export, resolved independently of the app's CWD.
 * Initialized only in the operation-scoped, terminable decoder worker; no host fonts,
 * resource directories, external image resolvers, or network callbacks are supplied. */
export async function decodeSvg(bytes: Uint8Array, header: ImageHeader): Promise<Uint8Array<ArrayBuffer>> {
  initialized ??= readFile(new URL(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"))).then(async (wasm) => { await initWasm(wasm); });
  await initialized;
  const renderer = new Resvg(bytes, { font: { loadSystemFonts: false } });
  try {
    if (renderer.width !== header.width || renderer.height !== header.height || renderer.imagesToResolve().length !== 0) {
      throw new ImageResourceError("malformed-image", "SVG renderer disagrees with bounded intrinsic metadata or resource preflight.");
    }
    const rendered = renderer.render();
    try {
      const premultiplied = rendered.pixels;
      if (rendered.width !== header.width || rendered.height !== header.height || premultiplied.byteLength !== header.width * header.height * 4) {
        throw new ImageResourceError("decode-failed", "SVG renderer returned unexpected pixel dimensions.");
      }
      // resvg exposes premultiplied sRGB RGBA. Publish one owned straight RGBA8 copy,
      // identical to the PNG/JPEG resource contract. Transparent RGB is canonical zero.
      const pixels = new Uint8Array(premultiplied.byteLength);
      for (let index = 0; index < pixels.byteLength; index += 4) {
        const alpha = premultiplied[index + 3] ?? 0;
        if (alpha !== 0) {
          pixels[index] = Math.min(255, Math.round((premultiplied[index] ?? 0) * 255 / alpha));
          pixels[index + 1] = Math.min(255, Math.round((premultiplied[index + 1] ?? 0) * 255 / alpha));
          pixels[index + 2] = Math.min(255, Math.round((premultiplied[index + 2] ?? 0) * 255 / alpha));
        }
        pixels[index + 3] = alpha;
      }
      return pixels;
    } finally { rendered.free(); }
  } finally { renderer.free(); }
}
