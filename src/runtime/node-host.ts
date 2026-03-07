import { readFile } from "node:fs/promises";

import type { RuntimeHost } from "./host.js";

/**
 * Creates a `RuntimeHost` backed by Node's `fs/promises.readFile()`.
 *
 * @returns Host adapter with `name = "node"`.
 */
export function createNodeHost(): RuntimeHost {
  return {
    name: "node",
    async readFileText(path: string): Promise<string> {
      return readFile(path, "utf8");
    }
  };
}
