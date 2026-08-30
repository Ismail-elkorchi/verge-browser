/** Opaque identity for one node in a single immutable web document snapshot. */
export type DocumentNodeRef = string & { readonly __documentNodeRef: unique symbol };

/** Half-open UTF-16 range in the decoded HTML source. */
export interface DocumentSourceRange {
  readonly start: number;
  readonly end: number;
  readonly provenance: "input" | "inferred";
}

export interface DocumentAttribute {
  readonly namespace: string | null;
  readonly prefix: string | null;
  readonly name: string;
  readonly value: string;
  readonly sourceRange: DocumentSourceRange | null;
}

interface WebNodeBase {
  readonly ref: DocumentNodeRef;
  readonly parent: DocumentNodeRef | null;
  readonly children: readonly DocumentNodeRef[];
  readonly sourceRange: DocumentSourceRange | null;
}

export interface WebDocumentRootNode extends WebNodeBase {
  readonly kind: "document";
}

export interface WebElementNode extends WebNodeBase {
  readonly kind: "element";
  readonly namespace: string;
  readonly prefix: string | null;
  readonly name: string;
  readonly attributes: readonly DocumentAttribute[];
  readonly templateContent: DocumentNodeRef | null;
}

export interface WebTemplateContentNode extends WebNodeBase {
  readonly kind: "template-content";
}

export interface WebTextNode extends WebNodeBase {
  readonly kind: "text";
  readonly value: string;
}

export interface WebCommentNode extends WebNodeBase {
  readonly kind: "comment";
  readonly value: string;
}

export interface WebProcessingInstructionNode extends WebNodeBase {
  readonly kind: "processing-instruction";
  readonly target: string;
  readonly data: string;
}

export interface WebDoctypeNode extends WebNodeBase {
  readonly kind: "doctype";
  readonly name: string;
}

export type WebDocumentNode =
  | WebDocumentRootNode
  | WebElementNode
  | WebTemplateContentNode
  | WebTextNode
  | WebCommentNode
  | WebProcessingInstructionNode
  | WebDoctypeNode;

export type DocumentLandmark =
  | "banner"
  | "navigation"
  | "main"
  | "complementary"
  | "contentinfo"
  | "search"
  | "form"
  | "region";

export type DocumentSemanticRole =
  | "document"
  | "article"
  | "heading"
  | "paragraph"
  | "list"
  | "listitem"
  | "definition"
  | "term"
  | "blockquote"
  | "code"
  | "link"
  | "button"
  | "textbox"
  | "checkbox"
  | "radio"
  | "combobox"
  | "table"
  | "rowgroup"
  | "row"
  | "cell"
  | "columnheader"
  | "rowheader"
  | "img"
  | "figure"
  | "separator"
  | "group"
  | "dialog"
  | "generic";

export interface DocumentSemanticEntry {
  readonly node: DocumentNodeRef;
  readonly role: DocumentSemanticRole;
  readonly landmark: DocumentLandmark | null;
  readonly accessibleName: string;
  readonly accessibleDescription: string;
  /** Excluded from semantic/accessibility projections; this does not itself suppress CSS boxes. */
  readonly accessibilityHidden: boolean;
  readonly behavior: "normal" | "forced-break" | "break-opportunity" | "replaced" | "form-control";
}

export type DocumentDirection = "ltr" | "rtl";
export type HtmlDirectionMode = "ltr" | "rtl" | "auto";
export type DocumentDirectionSource = "document-default" | "explicit" | "auto-first-strong" | "inherited" | "telephone-input";
export type RenderedTextKind = "accessible-name" | "alternative-text" | "control-value" | "label" | "placeholder" | "title";

export interface RenderedTextDirection {
  readonly kind: RenderedTextKind;
  readonly value: string;
  readonly direction: DocumentDirection;
}

/** HTML directionality is indexed separately from CSS computed `direction`. */
export interface DocumentDirectionality {
  readonly node: DocumentNodeRef;
  readonly direction: DocumentDirection;
  readonly htmlMode: HtmlDirectionMode | null;
  readonly source: DocumentDirectionSource;
  readonly isolates: boolean;
  readonly overrides: boolean;
  readonly renderedText: readonly RenderedTextDirection[];
}

export interface DocumentLink {
  readonly node: DocumentNodeRef;
  readonly index: number;
  readonly href: string;
  readonly destination: string;
  readonly label: string;
}

export type DocumentStylesheetReference = {
  readonly kind: "external";
  readonly owner: DocumentNodeRef;
  readonly order: number;
  readonly href: string;
  readonly destination: string;
  readonly media: string | null;
} | {
  readonly kind: "embedded";
  readonly owner: DocumentNodeRef;
  readonly order: number;
  readonly cssText: string;
  readonly media: string | null;
};

export interface DocumentMetadataEntry {
  readonly node: DocumentNodeRef;
  readonly name: string;
  readonly content: string;
}

export interface DocumentHeading {
  readonly node: DocumentNodeRef;
  readonly level: number;
  readonly text: string;
}

export interface DocumentOutlineEntry extends DocumentHeading {
  readonly parentHeading: DocumentNodeRef | null;
}

export interface DocumentLabel {
  readonly node: DocumentNodeRef;
  readonly target: DocumentNodeRef;
  readonly text: string;
}

export interface DocumentFormControlBase {
  readonly node: DocumentNodeRef;
  readonly form: DocumentNodeRef | null;
  readonly name: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly required: boolean;
}

export interface DocumentTextControl extends DocumentFormControlBase {
  readonly kind: "text";
  readonly inputType: "text" | "search" | "email" | "url" | "tel" | "password" | "number";
  readonly defaultValue: string;
  readonly placeholder: string | null;
  readonly readOnly: boolean;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
}

export interface DocumentTextareaControl extends DocumentFormControlBase {
  readonly kind: "textarea";
  readonly defaultValue: string;
  readonly placeholder: string | null;
  readonly readOnly: boolean;
}

export interface DocumentChoiceControl extends DocumentFormControlBase {
  readonly kind: "checkbox" | "radio";
  readonly value: string;
  readonly defaultChecked: boolean;
}

export interface DocumentSelectOption {
  readonly node: DocumentNodeRef;
  readonly select: DocumentNodeRef;
  readonly value: string;
  readonly label: string;
  readonly defaultSelected: boolean;
  readonly disabled: boolean;
}

export interface DocumentSelectControl extends DocumentFormControlBase {
  readonly kind: "select";
  readonly multiple: boolean;
  readonly options: readonly DocumentSelectOption[];
}

export interface DocumentHiddenControl {
  readonly node: DocumentNodeRef;
  readonly form: DocumentNodeRef | null;
  readonly kind: "hidden";
  readonly name: string;
  readonly defaultValue: string;
  readonly disabled: boolean;
}

export interface DocumentButtonControl extends DocumentFormControlBase {
  readonly kind: "submit" | "reset" | "button";
  readonly value: string;
  readonly formAction: string | null;
  readonly formMethod: "get" | "post" | "dialog" | null;
  readonly formEncoding: "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain" | null;
  readonly formNoValidate: boolean;
  readonly formTarget: string | null;
}

export interface DocumentUnsupportedControl extends DocumentFormControlBase {
  readonly kind: "unsupported";
  readonly inputType: string;
  readonly reason: "file-upload" | "unsupported-input";
}

export type DocumentFormControl =
  | DocumentTextControl
  | DocumentTextareaControl
  | DocumentChoiceControl
  | DocumentSelectControl
  | DocumentHiddenControl
  | DocumentButtonControl
  | DocumentUnsupportedControl;

export interface DocumentForm {
  readonly node: DocumentNodeRef;
  readonly index: number;
  readonly label: string;
  readonly method: "get" | "post" | "dialog";
  readonly encoding: "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain";
  readonly action: string;
  readonly noValidate: boolean;
  readonly target: string | null;
  readonly controls: readonly DocumentFormControl[];
  readonly submitters: readonly DocumentNodeRef[];
}

export interface DocumentReplacedContent {
  readonly node: DocumentNodeRef;
  readonly kind: "image" | "media" | "embedded" | "svg" | "mathml";
  readonly source: string | null;
  readonly fallbackText: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface DocumentDisclosure {
  readonly node: DocumentNodeRef;
  readonly kind: "details" | "dialog";
  readonly initiallyOpen: boolean;
  readonly summary: DocumentNodeRef | null;
}

export interface DocumentParserDiagnostic {
  readonly id: string;
  readonly message: string;
  readonly sourceRange: DocumentSourceRange | null;
}

export interface DocumentSourceMetadata {
  readonly inputKind: "text" | "bytes" | "stream";
  readonly transportBytes: number | null;
  readonly decodedUtf8Bytes: number;
  readonly decodedCodeUnits: number;
  readonly encoding: string | null;
  readonly encodingSource: "already-decoded" | "bom" | "transport" | "meta" | "default";
  readonly parserNodeCount: number;
  readonly parserMaxDepth: number;
}

export interface DocumentIndexLimits {
  readonly maxIndexedNodes: number;
  readonly maxTextCodeUnits: number;
  readonly maxLinks: number;
  readonly maxStylesheets: number;
  readonly maxForms: number;
  readonly maxControlsPerForm: number;
  readonly maxOptionsPerSelect: number;
  readonly maxHeadings: number;
}

export type DocumentIndexOutcome = {
  readonly status: "complete";
  readonly indexedNodes: number;
} | {
  readonly status: "truncated";
  readonly indexedNodes: number;
  readonly exhausted: keyof DocumentIndexLimits;
  readonly limit: number;
};

export type DocumentAction =
  | { readonly kind: "follow-link"; readonly target: DocumentNodeRef }
  | { readonly kind: "reset-form"; readonly target: DocumentNodeRef }
  | { readonly kind: "set-control-value"; readonly target: DocumentNodeRef; readonly value: string }
  | { readonly kind: "set-checked"; readonly target: DocumentNodeRef; readonly checked: boolean }
  | { readonly kind: "set-selected-options"; readonly target: DocumentNodeRef; readonly options: readonly DocumentNodeRef[] }
  | { readonly kind: "set-open"; readonly target: DocumentNodeRef; readonly open: boolean }
  | { readonly kind: "focus"; readonly target: DocumentNodeRef | null }
  | { readonly kind: "hover"; readonly target: DocumentNodeRef | null }
  | { readonly kind: "activate"; readonly target: DocumentNodeRef | null };

export interface DocumentControlState {
  readonly values: readonly string[];
  readonly checked: boolean | null;
  readonly selected: readonly DocumentNodeRef[];
}

export interface DocumentState {
  readonly controls: ReadonlyMap<DocumentNodeRef, DocumentControlState>;
  readonly open: ReadonlySet<DocumentNodeRef>;
  readonly focus: DocumentNodeRef | null;
  readonly hover: DocumentNodeRef | null;
  readonly active: DocumentNodeRef | null;
  readonly urlTarget: DocumentNodeRef | null;
}

/** Deliberate read-only document structure exposed by navigation snapshots. */
export interface WebDocumentSnapshot {
  readonly root: DocumentNodeRef;
  readonly documentElement: DocumentNodeRef | null;
  readonly head: DocumentNodeRef | null;
  readonly body: DocumentNodeRef | null;
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly baseUrl: string;
  readonly title: string;
  readonly sourceMetadata: DocumentSourceMetadata;
  /** Retained decoded source when parsing was configured to preserve it. */
  readonly sourceText: string | null;
  node(ref: DocumentNodeRef): WebDocumentNode;
  parent(ref: DocumentNodeRef): WebDocumentNode | null;
  children(ref: DocumentNodeRef): readonly WebDocumentNode[];
  attribute(ref: DocumentNodeRef, name: string, namespace?: string | null): string | null;
  text(ref: DocumentNodeRef, maxCodeUnits?: number): string;
  textSourceRange(
    ref: DocumentNodeRef,
    startCodeUnit: number,
    endCodeUnit: number
  ): DocumentSourceRange | null;
}

/** @internal Indexed document contract consumed by browser subsystems. */
export interface IndexedWebDocumentSnapshot extends WebDocumentSnapshot {
  readonly metadata: readonly DocumentMetadataEntry[];
  readonly links: readonly DocumentLink[];
  readonly stylesheets: readonly DocumentStylesheetReference[];
  readonly forms: readonly DocumentForm[];
  readonly controls: readonly DocumentFormControl[];
  readonly labels: readonly DocumentLabel[];
  readonly headings: readonly DocumentHeading[];
  readonly outline: readonly DocumentOutlineEntry[];
  readonly landmarks: readonly DocumentSemanticEntry[];
  readonly replacedContent: readonly DocumentReplacedContent[];
  readonly disclosures: readonly DocumentDisclosure[];
  readonly diagnostics: readonly DocumentParserDiagnostic[];
  readonly indexOutcome: DocumentIndexOutcome;
  semantic(ref: DocumentNodeRef): DocumentSemanticEntry | null;
  elementById(id: string): DocumentNodeRef | null;
  form(ref: DocumentNodeRef): DocumentForm | null;
  formOwner(ref: DocumentNodeRef): DocumentNodeRef | null;
  control(ref: DocumentNodeRef): DocumentFormControl | null;
  radioGroup(ref: DocumentNodeRef): readonly DocumentChoiceControl[];
  option(ref: DocumentNodeRef): DocumentSelectOption | null;
  label(ref: DocumentNodeRef): DocumentLabel | null;
  link(ref: DocumentNodeRef): DocumentLink | null;
  heading(ref: DocumentNodeRef): DocumentHeading | null;
  replaced(ref: DocumentNodeRef): DocumentReplacedContent | null;
  disclosure(ref: DocumentNodeRef): DocumentDisclosure | null;
  directionality(ref: DocumentNodeRef): DocumentDirectionality;
  directionForRenderedText(ref: DocumentNodeRef, value: string): DocumentDirection;
}
