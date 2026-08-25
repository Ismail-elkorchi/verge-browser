import type {
  DocumentNodeRef,
  DocumentState,
  IndexedWebDocumentSnapshot
} from "../../document/index.js";

export interface CssColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export type CssLengthUnit = "px" | "em" | "rem" | "ch" | "%" | "vw" | "vh";
export type CssLength =
  | { readonly kind: "length"; readonly value: number; readonly unit: CssLengthUnit }
  | { readonly kind: "zero" }
  | { readonly kind: "auto" }
  | { readonly kind: "none" };

export interface CssEdges {
  readonly top: CssLength;
  readonly right: CssLength;
  readonly bottom: CssLength;
  readonly left: CssLength;
}

export type CssLegacyClip =
  | { readonly kind: "auto" }
  | { readonly kind: "rect"; readonly edges: CssEdges };

export type CssClipPath =
  | { readonly kind: "none" }
  | { readonly kind: "inset"; readonly offsets: CssEdges };

export type CssDisplayInternal =
  | "table-row-group"
  | "table-header-group"
  | "table-footer-group"
  | "table-row"
  | "table-cell"
  | "table-column-group"
  | "table-column"
  | "table-caption";

export type ComputedDisplay =
  | { readonly box: "none" | "contents" }
  | {
      readonly box: "principal";
      readonly outer: "block" | "inline";
      readonly inner: "flow" | "flow-root" | "table" | "flex" | "grid";
      readonly listItem: boolean;
      readonly internal: CssDisplayInternal | null;
      readonly replaced: boolean;
    };

export type ComputedWhiteSpace = "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line" | "break-spaces";

export type ComputedLineHeight =
  | { readonly kind: "normal" }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "length"; readonly value: CssLength };

export type ComputedVerticalAlign =
  | { readonly kind: "keyword"; readonly value: "baseline" | "sub" | "super" | "top" | "text-top" | "middle" | "bottom" | "text-bottom" }
  | { readonly kind: "length"; readonly value: CssLength };

export interface ComputedTextStyle {
  readonly color: CssColor | null;
  readonly background: CssColor | null;
  readonly fontWeight: number;
  readonly fontStyle: "normal" | "italic" | "oblique";
  readonly underline: boolean;
  readonly lineThrough: boolean;
  readonly textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
  readonly whiteSpace: ComputedWhiteSpace;
  readonly textAlign: "left" | "center" | "right";
  readonly textIndent: CssLength;
  /** Absolute computed font size. */
  readonly fontSize: CssLength;
  readonly lineHeight: ComputedLineHeight;
  readonly verticalAlign: ComputedVerticalAlign;
}

export interface ComputedBoxStyle {
  readonly margin: CssEdges;
  readonly padding: CssEdges;
  readonly width: CssLength;
  readonly minWidth: CssLength;
  readonly maxWidth: CssLength;
  readonly height: CssLength;
  readonly minHeight: CssLength;
  readonly maxHeight: CssLength;
  readonly boxSizing: "content-box" | "border-box";
  readonly rowGap: CssLength;
  readonly columnGap: CssLength;
  readonly borderStyle: "none" | "solid";
  readonly borderWidths: CssEdges;
  readonly borderColor: CssColor | null;
  readonly flexDirection: "row" | "row-reverse" | "column" | "column-reverse";
  readonly flexWrap: "nowrap" | "wrap" | "wrap-reverse";
  readonly justifyContent: "start" | "center" | "end" | "space-between";
  readonly alignItems: "start" | "center" | "end" | "stretch";
  readonly position: "static" | "relative" | "absolute" | "fixed" | "sticky";
  readonly legacyClip: CssLegacyClip;
  readonly clipPath: CssClipPath;
  readonly gridTemplateColumns: readonly CssGridTrack[];
  readonly gridColumn: number | null;
  readonly overflowX: "visible" | "hidden" | "clip";
  readonly overflowY: "visible" | "hidden" | "clip";
}

export type CssGridBreadth =
  | { readonly kind: "auto" }
  | { readonly kind: "fraction"; readonly value: number }
  | { readonly kind: "length"; readonly value: CssLength };

export type CssGridTrack = CssGridBreadth | {
  readonly kind: "minmax";
  readonly minimum: CssGridBreadth;
  readonly maximum: CssGridBreadth;
};

export interface ComputedStyle {
  readonly display: ComputedDisplay;
  readonly visibility: "visible" | "hidden" | "collapse";
  readonly listStyleType:
    | "none"
    | "disc"
    | "circle"
    | "square"
    | "decimal"
    | "decimal-leading-zero"
    | "lower-alpha"
    | "upper-alpha";
  readonly text: ComputedTextStyle;
  readonly box: ComputedBoxStyle;
  /** Computed `content` for this pseudo-element; null on principal styles. */
  readonly generatedContent: string | null;
  readonly customProperties: ReadonlyMap<string, string>;
}

export type PseudoElementIdentity = "before" | "after" | "marker";

export interface StylesheetResource {
  readonly owner: DocumentNodeRef;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
  readonly media: string | null;
  readonly transportEncodingLabel: string | null;
}

export type StyleDiagnosticCode =
  | "stylesheet-fetch"
  | "stylesheet-limit"
  | "stylesheet-media"
  | "stylesheet-parse"
  | "unsupported-at-rule"
  | "selector-parse"
  | "selector-unknown"
  | "property-invalid"
  | "property-unsupported"
  | "value-unsupported";

export interface StyleDiagnostic {
  readonly code: StyleDiagnosticCode;
  readonly sourceUrl: string;
  readonly detail: string;
  readonly occurrences: number;
}

export interface StyleBudgets {
  readonly maxStylesheetSources: number;
  readonly maxStylesheetBytes: number;
  readonly maxInlineStylesheetBytes: number;
  readonly maxSelectorQueries: number;
  readonly maxSelectorSteps: number;
  readonly maxDiagnostics: number;
}

export type StyleOutcome =
  | { readonly status: "complete"; readonly computedNodes: number }
  | {
      readonly status: "truncated";
      readonly computedNodes: number;
      readonly budget: keyof StyleBudgets;
      readonly limit: number;
    }
  | { readonly status: "rejected"; readonly reason: "invalid-environment" | "invalid-document" }
  | { readonly status: "unsupported"; readonly feature: string };

export interface MediaEnvironment {
  readonly viewportWidthCssPx: number;
  readonly viewportHeightCssPx: number;
  readonly mediaType: "screen";
  readonly prefersColorScheme: "light" | "dark";
  readonly reducedMotion: boolean;
  readonly hover: "none" | "hover";
  readonly pointer: "none" | "coarse" | "fine";
}

export interface ResolveStylesInput {
  readonly document: IndexedWebDocumentSnapshot;
  readonly state: DocumentState;
  readonly resources: readonly StylesheetResource[];
  readonly initialDiagnostics?: readonly StyleDiagnostic[];
  readonly environment: MediaEnvironment;
  readonly budgets?: Partial<StyleBudgets>;
  readonly signal?: AbortSignal;
}

export interface StyleSnapshot {
  readonly document: IndexedWebDocumentSnapshot;
  readonly environment: MediaEnvironment;
  readonly diagnostics: readonly StyleDiagnostic[];
  readonly stylesheetCount: number;
  readonly outcome: StyleOutcome;
  /** Total for every element retained by the document snapshot. */
  style(node: DocumentNodeRef): ComputedStyle;
  pseudo(node: DocumentNodeRef, identity: PseudoElementIdentity): ComputedStyle | null;
}
