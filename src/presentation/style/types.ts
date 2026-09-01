import type {
  ComponentValue,
  CssDeclaration,
  CssQualifiedRule,
  CssStylesheet,
  PropertyValidationSession,
  SelectorList,
  SelectorMatchSession,
  SelectorQueryResult,
  SelectorSpecificity,
} from "@ismail-elkorchi/css-parser";

import type {
  DocumentNodeRef,
  DocumentState,
  IndexedWebDocumentSnapshot,
  WebDocumentNode
} from "../../document/index.js";
import type {
  CssGridAutoFlow,
  CssGridAutoTrackList,
  CssGridPlacement,
  CssGridTemplateAreas,
  CssGridTrackList
} from "./grid/index.js";
import type { CssContentAlignment, CssSelfAlignment } from "./alignment.js";
import type {
  CssBorderCollapse,
  CssBorderColors,
  CssBorderSpacing,
  CssBorderStyles,
  CssCaptionSide,
  CssEmptyCells,
  CssTableLayout,
} from "./table/index.js";

export interface CssColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export type CssLengthUnit = "px" | "em" | "rem" | "ch" | "%" | "vw" | "vh";

export type CssLengthPercentageExpression =
  | { readonly kind: "value"; readonly value: number; readonly unit: CssLengthUnit }
  | { readonly kind: "negate"; readonly value: CssLengthPercentageExpression }
  | {
      readonly kind: "sum";
      readonly left: CssLengthPercentageExpression;
      readonly right: CssLengthPercentageExpression;
    }
  | { readonly kind: "product"; readonly value: CssLengthPercentageExpression; readonly factor: number }
  | { readonly kind: "minimum"; readonly values: readonly CssLengthPercentageExpression[] }
  | { readonly kind: "maximum"; readonly values: readonly CssLengthPercentageExpression[] }
  | {
      readonly kind: "clamp";
      readonly minimum: CssLengthPercentageExpression;
      readonly preferred: CssLengthPercentageExpression;
      readonly maximum: CssLengthPercentageExpression;
    };

export interface CssLengthPercentageCalculation {
  readonly expression: CssLengthPercentageExpression;
  readonly percentageDependence: "none" | "percentage" | "mixed";
}

export type CssLength =
  | { readonly kind: "length"; readonly value: number; readonly unit: CssLengthUnit }
  | { readonly kind: "calculation"; readonly calculation: CssLengthPercentageCalculation }
  | { readonly kind: "zero" }
  | { readonly kind: "auto" }
  | { readonly kind: "none" };

export type CssFlexBasis = CssLength | { readonly kind: "content" };
export type CssGap = CssLength | { readonly kind: "normal" };

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
  readonly direction: "ltr" | "rtl";
  readonly unicodeBidi: "normal" | "embed" | "isolate" | "bidi-override" | "isolate-override" | "plaintext";
  readonly textAlign: "start" | "end" | "left" | "center" | "right";
  readonly lineBreak: "auto" | "normal" | "anywhere";
  readonly wordBreak: "normal" | "break-all" | "keep-all" | "break-word";
  readonly overflowWrap: "normal" | "anywhere" | "break-word";
  readonly hyphens: "none" | "manual";
  readonly tabSize: number;
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
  readonly rowGap: CssGap;
  readonly columnGap: CssGap;
  readonly borderStyles: CssBorderStyles;
  readonly borderWidths: CssEdges;
  readonly borderColors: CssBorderColors;
  readonly tableLayout: CssTableLayout;
  readonly borderCollapse: CssBorderCollapse;
  readonly borderSpacing: CssBorderSpacing;
  readonly captionSide: CssCaptionSide;
  readonly emptyCells: CssEmptyCells;
  readonly flexDirection: "row" | "row-reverse" | "column" | "column-reverse";
  readonly flexWrap: "nowrap" | "wrap" | "wrap-reverse";
  readonly flexGrow: number;
  readonly flexShrink: number;
  readonly flexBasis: CssFlexBasis;
  readonly order: number;
  readonly justifyContent: CssContentAlignment;
  readonly alignItems: CssSelfAlignment;
  readonly alignSelf: CssSelfAlignment;
  readonly alignContent: CssContentAlignment;
  readonly justifyItems: CssSelfAlignment;
  readonly justifySelf: CssSelfAlignment;
  readonly position: "static" | "relative" | "absolute" | "fixed" | "sticky";
  readonly inset: CssEdges;
  readonly zIndex: number | null;
  readonly float: "none" | "left" | "right";
  readonly clear: "none" | "left" | "right" | "both";
  readonly legacyClip: CssLegacyClip;
  readonly clipPath: CssClipPath;
  readonly gridTemplateColumns: CssGridTrackList;
  readonly gridTemplateRows: CssGridTrackList;
  readonly gridTemplateAreas: CssGridTemplateAreas;
  readonly gridAutoColumns: CssGridAutoTrackList;
  readonly gridAutoRows: CssGridAutoTrackList;
  readonly gridAutoFlow: CssGridAutoFlow;
  readonly gridPlacement: CssGridPlacement;
  readonly overflowX: "visible" | "hidden" | "clip";
  readonly overflowY: "visible" | "hidden" | "clip";
}

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

/** A qualified cascade-layer name, ordered one nesting level at a time. */
export type CascadeLayerPath = readonly string[];

export interface StylesheetResource {
  readonly sourceKind: "embedded" | "linked" | "imported";
  readonly owner: DocumentNodeRef;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly contentType: string | null;
  /** Verified, decoded CSS syntax retained from dependency admission. */
  readonly syntax: CssStylesheet;
  /** Transport size retained for resource and style budgets after raw bytes are released. */
  readonly byteSize: number;
  /** Stable identity of the admitted decoded source. */
  readonly contentFingerprint: string;
  readonly parserDiagnostics: readonly string[];
  /** Document stylesheet order shared by the root sheet and all recursive imports. */
  readonly rootOrder: number;
  /** Depth-first cascade order within one document stylesheet root. */
  readonly dependencyOrder: number;
  readonly importDepth: number;
  readonly importedFrom: string | null;
  readonly importLayer: CascadeLayerPath | null;
  readonly mediaConditions: readonly string[];
  readonly supportsConditions: readonly string[];
  /** Qualified layer names established before this imported source enters the cascade. */
  readonly predeclaredLayers: readonly CascadeLayerPath[];
  /** Rule count verified when this source was admitted to the dependency graph. */
  readonly parsedRules: number;
}

export interface StylesheetImportDependency {
  readonly request: string;
  readonly media: string | null;
  /** null is unlayered, [] requests a fresh anonymous import layer. */
  readonly layer: CascadeLayerPath | null;
  readonly supports: string | null;
  readonly order: number;
  readonly precedingLayers: readonly CascadeLayerPath[];
}

export type StylesheetDependencyInspection =
  | {
      readonly status: "complete";
      readonly imports: readonly StylesheetImportDependency[];
      readonly parsedRules: number;
      readonly syntax: CssStylesheet;
      readonly byteSize: number;
      readonly contentFingerprint: string;
      readonly parserDiagnostics: readonly string[];
    }
  | { readonly status: "rejected"; readonly reason: "parse" | "encoding" };

export interface StylesheetSyntaxInstrumentation {
  record(stage: "stylesheet-syntax-parsing", elapsedMilliseconds: number): void;
}

export type StyleDiagnosticCode =
  | "stylesheet-fetch"
  | "stylesheet-limit"
  | "stylesheet-media"
  | "stylesheet-parse"
  | "stylesheet-cycle"
  | "stylesheet-import"
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
  readonly instrumentation?: {
    record(stage: "selector-matching" | "custom-property-substitution", elapsedMilliseconds: number): void;
  };
  readonly program: StylesheetProgram;
  readonly state: DocumentState;
  readonly environment: MediaEnvironment;
  readonly budgets?: Partial<StyleBudgets>;
  readonly signal?: AbortSignal;
}

export type SelectorStateDependency =
  | "document-structural"
  | "target"
  | "focus"
  | "hover"
  | "active"
  | "checked-selected"
  | "disclosure-open";

export interface CompiledSelectorProgram {
  readonly selector: SelectorList;
  readonly fingerprint: string;
  readonly pseudoElement: PseudoElementIdentity | null;
  readonly specificity: SelectorSpecificity;
  readonly dependencies: ReadonlySet<SelectorStateDependency>;
}

export interface CompiledDeclarationProgram {
  readonly declaration: CssDeclaration;
  readonly property: string | null;
  readonly value: readonly ComponentValue[];
  readonly serializedValue: string;
  readonly containsVariableReference: boolean;
}

export interface StylesheetProgramSource {
  readonly sourceUrl: string;
  readonly origin: "user-agent" | "author";
  readonly stylesheet: CssStylesheet;
  readonly mediaConditions: readonly string[];
  readonly supportsConditions: readonly string[];
  readonly layer: CascadeLayerPath | null;
  readonly predeclaredLayers: readonly CascadeLayerPath[];
}

export interface StylesheetProgram {
  readonly document: IndexedWebDocumentSnapshot;
  readonly sources: readonly StylesheetProgramSource[];
  readonly compiledSelectors: ReadonlyMap<CssQualifiedRule, readonly CompiledSelectorProgram[]>;
  readonly compiledDeclarations: ReadonlyMap<CssDeclaration, CompiledDeclarationProgram>;
  readonly selectorRuntime: StylesheetSelectorRuntime;
  readonly propertyValidation: PropertyValidationSession;
  readonly substitutedValues: CustomPropertySubstitutionCache;
  readonly inlineDeclarations: ReadonlyMap<DocumentNodeRef, readonly CssDeclaration[]>;
  readonly elementNodes: readonly DocumentNodeRef[];
  readonly totalNodes: number;
  readonly stateDependencies: ReadonlySet<SelectorStateDependency>;
  readonly authorStateDependencies: ReadonlySet<SelectorStateDependency>;
  readonly dependencies: StylesheetProgramDependencies;
  readonly diagnostics: readonly StyleDiagnostic[];
  readonly authorStylesheetCount: number;
  readonly retainedByteSize: number;
  readonly fingerprint: string;
  readonly truncatedBudgets: ReadonlySet<keyof StyleBudgets>;
}

export interface RetainedSelectorMatchSet {
  readonly dependencies: ReadonlySet<SelectorStateDependency>;
  readonly result: SelectorQueryResult<WebDocumentNode>;
}

export interface StylesheetSelectorRuntime {
  state: DocumentState | null;
  authorSession: SelectorMatchSession<WebDocumentNode> | null;
  userAgentSession: SelectorMatchSession<WebDocumentNode> | null;
  sessionMaxSteps: number;
  readonly matches: Map<string, RetainedSelectorMatchSet>;
  computedSnapshot: StyleSnapshot | null;
  computedEnvironment: string | null;
  clear(): void;
}

export interface StylesheetProgramDependencies {
  readonly mediaInlineSize: boolean;
  readonly mediaBlockSize: boolean;
  readonly mediaColorScheme: boolean;
  readonly mediaReducedMotion: boolean;
  readonly mediaHover: boolean;
  readonly mediaPointer: boolean;
  readonly viewportBlockSize: boolean;
}

export interface CustomPropertySubstitutionCache {
  readonly size: number;
  get(key: string): SubstitutedCssValue | null | undefined;
  set(key: string, value: SubstitutedCssValue | null): void;
  clear(): void;
}

export interface SubstitutedCssValue {
  readonly components: readonly ComponentValue[];
  readonly serializedValue: string;
}

export interface CompileStylesheetProgramInput {
  readonly document: IndexedWebDocumentSnapshot;
  readonly resources: readonly StylesheetResource[];
  readonly initialDiagnostics?: readonly StyleDiagnostic[];
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
