import type { RuntimeHost } from "./host.js";

interface BunFileApi {
  text(): Promise<string>;
}

interface BunApi {
  file(path: string): BunFileApi;
}

function resolveBunApi(): BunApi | null {
  const bunCandidate = (globalThis as { Bun?: unknown }).Bun;
  if (!bunCandidate || typeof bunCandidate !== "object") {
    return null;
  }
  if (!("file" in bunCandidate)) {
    return null;
  }
  const file = (bunCandidate as { file?: unknown }).file;
  if (typeof file !== "function") {
    return null;
  }
  return {
    file: file as (path: string) => BunFileApi
  };
}

/**
 * Creates a `RuntimeHost` backed by `Bun.file(path).text()`.
 *
 * @returns Host adapter with `name = "bun"`.
 * @throws {Error} When the current runtime does not expose the Bun file API.
 */
export function createBunHost(): RuntimeHost {
  return {
    name: "bun",
    async readFileText(path: string): Promise<string> {
      const bunApi = resolveBunApi();
      if (bunApi === null) {
        await Promise.resolve();
        throw new Error("Bun runtime API is unavailable");
      }
      return bunApi.file(path).text();
    }
  };
}
