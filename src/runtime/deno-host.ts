import type { RuntimeHost } from "./host.js";

interface DenoApi {
  readTextFile(path: string): Promise<string>;
}

function resolveDenoApi(): DenoApi | null {
  const denoCandidate = (globalThis as { Deno?: unknown }).Deno;
  if (!denoCandidate || typeof denoCandidate !== "object") {
    return null;
  }
  if (!("readTextFile" in denoCandidate)) {
    return null;
  }
  const readTextFile = (denoCandidate as { readTextFile?: unknown }).readTextFile;
  if (typeof readTextFile !== "function") {
    return null;
  }
  return {
    readTextFile: readTextFile as (path: string) => Promise<string>
  };
}

/**
 * Creates a `RuntimeHost` backed by `Deno.readTextFile()`.
 *
 * @returns Host adapter with `name = "deno"`.
 * @throws {Error} When the current runtime does not expose the Deno file API.
 */
export function createDenoHost(): RuntimeHost {
  return {
    name: "deno",
    async readFileText(path: string): Promise<string> {
      const denoApi = resolveDenoApi();
      if (denoApi === null) {
        await Promise.resolve();
        throw new Error("Deno runtime API is unavailable");
      }
      return denoApi.readTextFile(path);
    }
  };
}
