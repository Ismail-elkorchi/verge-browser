export type RenderStage =
  | "stylesheet-syntax-parsing"
  | "stylesheet-program-compilation"
  | "selector-matching"
  | "custom-property-substitution"
  | "computed-style-resolution"
  | "box-tree-construction"
  | "inline-item-stream-construction"
  | "logical-search-index-construction"
  | "normal-flow-layout"
  | "fixed-sticky-resolution"
  | "document-display-list-construction"
  | "display-list-spatial-index-construction"
  | "document-geometry-index-construction"
  | "spatial-query"
  | "viewport-display-list-construction"
  | "cell-rasterization"
  | "terminal-index-construction"
  | "terminal-ui-element-tree-construction";

export interface RenderStageMeasurement {
  readonly stage: RenderStage;
  readonly invocations: number;
  readonly elapsedMilliseconds: number;
}

export interface RenderInstrumentation {
  record(stage: RenderStage, elapsedMilliseconds: number): void;
}

export class RenderStageMetrics implements RenderInstrumentation {
  readonly #values = new Map<RenderStage, { invocations: number; elapsedMilliseconds: number }>();

  public record(stage: RenderStage, elapsedMilliseconds: number): void {
    const value = this.#values.get(stage) ?? { invocations: 0, elapsedMilliseconds: 0 };
    value.invocations += 1;
    value.elapsedMilliseconds += Math.max(0, elapsedMilliseconds);
    this.#values.set(stage, value);
  }

  public snapshot(): readonly RenderStageMeasurement[] {
    return Object.freeze([...this.#values].map(([stage, value]) => Object.freeze({ stage, ...value })));
  }
}

export function measured<T>(
  instrumentation: RenderInstrumentation | undefined,
  stage: RenderStage,
  operation: () => T,
): T {
  if (instrumentation === undefined) return operation();
  const started = performance.now();
  try {
    return operation();
  } finally {
    instrumentation.record(stage, performance.now() - started);
  }
}
