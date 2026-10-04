import type { StyleDiagnostic, StyleDiagnosticCode } from "./types.js";

export function diagnosticIdentity(code: StyleDiagnosticCode, sourceUrl: string, detail: string): string {
  return `${code}\u0000${sourceUrl}\u0000${detail}`;
}

/** Shared bounded diagnostics retain occurrence counts, including suppressed reports. */
export class DiagnosticCollector {
  readonly #values: StyleDiagnostic[] = [];
  readonly #indices = new Map<string, number>();
  readonly #limit: number;
  #omitted: number;

  public constructor(limit: number, initial: readonly StyleDiagnostic[] = [], omitted = 0) {
    this.#limit = limit;
    this.#omitted = omitted;
    for (const diagnostic of initial) this.add(diagnostic.code, diagnostic.sourceUrl, diagnostic.detail, diagnostic.occurrences);
  }
  public get omittedDiagnosticCount(): number { return this.#omitted; }
  public add(code: StyleDiagnosticCode, sourceUrl: string, detail: string, occurrences = 1): void {
    const identity = diagnosticIdentity(code, sourceUrl, detail);
    const index = this.#indices.get(identity);
    if (index !== undefined) {
      const current = this.#values[index];
      if (current !== undefined) this.#values[index] = { ...current, occurrences: current.occurrences + occurrences };
    } else if (this.#values.length >= this.#limit) this.#omitted += occurrences;
    else {
      this.#indices.set(identity, this.#values.length);
      this.#values.push({ code, sourceUrl, detail, occurrences });
    }
  }
  public result(): readonly StyleDiagnostic[] {
    return Object.freeze(this.#values.map((value) => Object.freeze(value)));
  }
}
