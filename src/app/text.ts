import {
  TEXT_CONTENT_POLICY,
  extractText,
  type DocumentTree,
  type FragmentTree,
  type HtmlNode
} from "@ismail-elkorchi/html-parser";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TOKENS = 250_000;
const MAX_TIME_MS = 20_000;

/**
 * Reads complete descendant text under Verge's bounded application profile.
 * Callers that require complete semantic values must fail instead of silently
 * accepting a retained prefix.
 */
export function extractCompleteText(node: DocumentTree | FragmentTree | HtmlNode): string {
  const result = extractText(node, {
    policy: TEXT_CONTENT_POLICY,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    maxTokens: MAX_TOKENS,
    maxTimeMs: MAX_TIME_MS
  });

  if (result.truncated) {
    throw new Error(
      `Text extraction exceeded Verge's application limit (${String(result.totalBytes)} UTF-8 bytes)`
    );
  }

  return result.text;
}
