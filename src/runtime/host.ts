export type RuntimeName = "node" | "deno" | "bun";

export interface RuntimeHost {
  readonly name: RuntimeName;
  readFileText(path: string): Promise<string>;
}
