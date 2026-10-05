export { parseWebDocument, parseWebDocumentBytes, parseWebDocumentStream } from "./parse.js";
export type {
  WebDocumentBytesOptions,
  WebDocumentParseBudgetOptions,
  WebDocumentParseContext,
  WebDocumentParseOptions,
  WebDocumentStreamBudgetOptions,
  WebDocumentStreamOptions
} from "./parse.js";
export { applyDocumentAction, createDocumentState, snapshotDocumentState, controlState, controlValues, controlChecked, controlSelections } from "./state.js";
export type * from "./types.js";
export { documentImageMetadata } from "./image-resources.js";
export type { DocumentImageMetadata, DocumentImageResource, ImageFailureCode } from "./image-resources.js";
export type {
  HtmlTableCellMetadata,
  HtmlTableColumnMetadata,
  HtmlTableColumnGroupMetadata,
  HtmlTableMetadata,
} from "./table/index.js";

export { resolveDocumentFragment, type DocumentFragmentTarget } from "./fragment.js";

export { parseHtmlInteger, htmlListMetadata, htmlListItemValue } from "./html-integer.js";
export { documentTextEquivalent, semanticNameFromContents, type GeneratedTextEquivalent } from "./text-equivalent.js";
