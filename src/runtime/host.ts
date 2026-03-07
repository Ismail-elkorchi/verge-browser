/** Runtime names supported by the file-host adapters exported by this package. */
export type RuntimeName = "node" | "deno" | "bun";

/** Minimal runtime abstraction for reading local text files in deterministic workflows. */
export interface RuntimeHost {
  /** Runtime label used for reporting and diagnostics. */
  readonly name: RuntimeName;
  /** Reads a local UTF-8 text file from the current runtime. */
  readFileText(path: string): Promise<string>;
}
