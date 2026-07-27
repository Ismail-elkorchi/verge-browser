import {
  TEXT_CONTENT_POLICY,
  VISIBLE_TEXT_HTML_POLICY,
  extractText,
  iterateText
} from "@ismail-elkorchi/html-parser";

const BASE_LIMITS = Object.freeze({
  maxOutputBytes: 8 * 1024 * 1024,
  maxTokens: 1_000_000,
  maxTimeMs: 20_000
});

const VISIBLE_LIMITS = Object.freeze({
  ...BASE_LIMITS,
  maxFallbackInputBytes: 2 * 1024 * 1024,
  maxFallbackNodes: 250_000
});

function requireComplete(result) {
  if (result.truncated) {
    throw new Error(
      `Evaluation text exceeded its configured bounds (${String(result.totalBytes)} UTF-8 bytes)`
    );
  }
  return result;
}

export function extractEvaluationText(nodeOrTree, options = {}) {
  return requireComplete(extractText(nodeOrTree, {
    ...VISIBLE_LIMITS,
    ...options,
    policy: VISIBLE_TEXT_HTML_POLICY
  })).text;
}

export function extractEvaluationTextContent(nodeOrTree) {
  return requireComplete(extractText(nodeOrTree, {
    ...BASE_LIMITS,
    policy: TEXT_CONTENT_POLICY
  })).text;
}

export function collectEvaluationTextTokens(nodeOrTree, options = {}) {
  const iterator = iterateText(nodeOrTree, {
    ...VISIBLE_LIMITS,
    ...options,
    policy: VISIBLE_TEXT_HTML_POLICY
  });
  const tokens = [];
  let next = iterator.next();
  while (!next.done) {
    tokens.push(next.value);
    next = iterator.next();
  }
  requireComplete(next.value);
  return tokens;
}
