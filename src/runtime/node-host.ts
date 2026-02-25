import { readFile } from "node:fs/promises";

import type { RuntimeHost } from "./host.js";

export function createNodeHost(): RuntimeHost {
  return {
    name: "node",
    async readFileText(path: string): Promise<string> {
      return readFile(path, "utf8");
    }
  };
}
