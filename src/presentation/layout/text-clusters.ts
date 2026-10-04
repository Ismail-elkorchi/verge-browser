import { PackedRows, ValueSequence, checkPackedMetadata } from "../../memory/packed.js";
import { registerRetainedOwner } from "../../memory/retained-cost.js";
import type { DocumentSourceRange } from "../../document/index.js";
import type { CssPixelLength } from "./fixed.js";
import type { LayoutTextCluster } from "./types.js";

interface ClusterIdentity {
  readonly contentStartCodeUnit: number;
  readonly contentEndCodeUnit: number;
  readonly sourceRange: DocumentSourceRange | null;
}

/** Geometry retains canonical logical item IDs plus only visual order/advance data. */
export class LayoutTextClusters extends ValueSequence<LayoutTextCluster> {
  readonly #source: ValueSequence<ClusterIdentity>;
  readonly #rows: PackedRows;
  readonly #text: string;
  public readonly length: number;
  public constructor(text: string, rows: PackedRows, source: ValueSequence<ClusterIdentity>) {
    super(); checkPackedMetadata(164, this); this.#text = text; this.#rows = rows.seal(); this.#source = source; this.length = rows.length;
    registerRetainedOwner(this, [rows, source, text], () => 48); Object.freeze(this);
  }
  public at(index: number): LayoutTextCluster | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const identity = this.#source.at(this.#rows.get(index, 0));
    if (identity === undefined) throw new RangeError("Missing canonical cluster identity.");
    const visualStartCodeUnit = this.#rows.get(index, 1), visualEndCodeUnit = this.#rows.get(index, 2);
    return { contentStartCodeUnit: identity.contentStartCodeUnit, contentEndCodeUnit: identity.contentEndCodeUnit,
      sourceRange: identity.sourceRange, text: this.#text.slice(visualStartCodeUnit, visualEndCodeUnit),
      visualStartCodeUnit, visualEndCodeUnit, advance: this.#rows.get(index, 3) as CssPixelLength };
  }
  /** Native-control runs own their generated offset map independently of document inline flow. */
  public static from(clusters: readonly LayoutTextCluster[]): LayoutTextClusters {
    const rows = new PackedRows(4, true, Math.max(1, Math.min(128, clusters.length)));
    const identities = new ClusterIdentities(clusters);
    let text = "";
    for (const [index, cluster] of clusters.entries()) {
      rows.push(index, text.length, text.length + cluster.text.length, cluster.advance); text += cluster.text;
    }
    return new LayoutTextClusters(text, rows, identities);
  }
}
class ClusterIdentities extends ValueSequence<ClusterIdentity> {
  readonly #rows: PackedRows;
  public readonly length: number;
  public constructor(clusters: readonly LayoutTextCluster[]) {
    super(); checkPackedMetadata(132, this); const rows = new PackedRows(5, true, Math.max(1, Math.min(128, clusters.length)));
    for (const cluster of clusters) rows.push(cluster.contentStartCodeUnit, cluster.contentEndCodeUnit,
      cluster.sourceRange?.start ?? -1, cluster.sourceRange?.end ?? -1, cluster.sourceRange?.provenance === "inferred" ? 1 : 0);
    this.#rows = rows.seal(); this.length = rows.length; registerRetainedOwner(this, [rows], () => 16); Object.freeze(this);
  }
  public at(index: number): ClusterIdentity | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const start = this.#rows.get(index, 2);
    return { contentStartCodeUnit: this.#rows.get(index, 0), contentEndCodeUnit: this.#rows.get(index, 1),
      sourceRange: start < 0 ? null : { start, end: this.#rows.get(index, 3), provenance: this.#rows.get(index, 4) === 1 ? "inferred" : "input" } };
  }
}
export const EMPTY_TEXT_CLUSTERS = LayoutTextClusters.from([]);
