import { performance } from "node:perf_hooks";

import { createRng, evaluateFuzzCase, generateFuzzHtml } from "./fuzz-lib.mjs";

const WRAP_TAGS = ["div", "section", "article", "aside", "nav", "main", "blockquote", "ul", "ol"];
const INSERT_FRAGMENTS = [
  "<p>alpha beta</p>",
  "<a href=\"https://example.test/x\">x</a>",
  "<table><tr><td>a</td><td>b</td></tr></table>",
  "<pre>line-1\\n  line-2</pre>",
  "<details><summary>s</summary><p>x</p></details>",
  "<form><input value=\"v\"><button value=\"b\">b</button></form>",
  "<img alt=\"img-alt\">",
  "<!-- guided -->"
];

function clampNumber(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function pickIndex(rng, length) {
  if (length <= 1) {
    return 0;
  }
  return Math.floor(rng() * length);
}

function pick(rng, values) {
  const index = pickIndex(rng, values.length);
  return values[index] ?? values[0];
}

function bucket(value, limits) {
  for (let index = 0; index < limits.length; index += 1) {
    if (value <= limits[index]) {
      return index;
    }
  }
  return limits.length;
}

function hasPattern(html, pattern) {
  return pattern.test(html) ? 1 : 0;
}

function mutateInsertFragment(html, rng) {
  const position = pickIndex(rng, html.length + 1);
  const fragment = pick(rng, INSERT_FRAGMENTS);
  return `${html.slice(0, position)}${fragment}${html.slice(position)}`;
}

function mutateDeleteWindow(html, rng) {
  if (html.length < 24) {
    return `${html}<span>delta</span>`;
  }
  const start = pickIndex(rng, html.length - 1);
  const maxWindow = clampNumber(Math.floor(html.length * 0.1), 8, 80);
  const windowSize = clampNumber(Math.floor(rng() * maxWindow) + 1, 1, maxWindow);
  const end = clampNumber(start + windowSize, 0, html.length);
  return `${html.slice(0, start)}${html.slice(end)}`;
}

function mutateDuplicateWindow(html, rng) {
  if (html.length < 16) {
    return `${html}<p>dup</p>`;
  }
  const start = pickIndex(rng, html.length - 1);
  const maxWindow = clampNumber(Math.floor(html.length * 0.12), 8, 120);
  const windowSize = clampNumber(Math.floor(rng() * maxWindow) + 1, 1, maxWindow);
  const end = clampNumber(start + windowSize, 0, html.length);
  const chunk = html.slice(start, end);
  const insertAt = pickIndex(rng, html.length + 1);
  return `${html.slice(0, insertAt)}${chunk}${html.slice(insertAt)}`;
}

function mutateToggleHidden(html) {
  if (/\shidden(?:\s|>|=)/i.test(html)) {
    return html.replace(/\shidden(?:\s|>|=)/i, " ");
  }
  const match = html.match(/<([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/);
  if (!match || match.index === undefined) {
    return `<div hidden>${html}</div>`;
  }
  const insertAt = match.index + match[0].length - 1;
  return `${html.slice(0, insertAt)} hidden${html.slice(insertAt)}`;
}

function mutateWrapNode(html, rng) {
  const tag = pick(rng, WRAP_TAGS);
  const start = pickIndex(rng, html.length + 1);
  const end = clampNumber(start + pickIndex(rng, Math.max(2, Math.floor(html.length * 0.25))), start, html.length);
  const inner = html.slice(start, end);
  const wrapped = `<${tag}>${inner}</${tag}>`;
  return `${html.slice(0, start)}${wrapped}${html.slice(end)}`;
}

function mutateWhitespace(html, rng) {
  if (html.length === 0) {
    return "<p>ws</p>";
  }
  const start = pickIndex(rng, html.length);
  const window = clampNumber(Math.floor(rng() * 24) + 4, 4, 24);
  const end = clampNumber(start + window, start, html.length);
  const segment = html.slice(start, end).replace(/[ \t\n\r]+/g, () => (rng() < 0.5 ? " " : "\n"));
  return `${html.slice(0, start)}${segment}${html.slice(end)}`;
}

function mutateHtml(html, rng) {
  const operators = [
    mutateInsertFragment,
    mutateDeleteWindow,
    mutateDuplicateWindow,
    mutateToggleHidden,
    mutateWrapNode,
    mutateWhitespace
  ];
  const operator = pick(rng, operators);
  const mutated = operator(html, rng);
  if (mutated.length === 0) {
    return "<p>empty-fallback</p>";
  }
  return mutated;
}

function signatureFromCaseResult(caseResult, html) {
  const parseErrorGroup = caseResult.parseErrorIds.slice(0, 3).join(",");
  const signature = [
    `pe:${String(bucket(caseResult.parseErrorCount, [0, 1, 3, 8]))}`,
    `line:${String(bucket(caseResult.lineCount, [10, 30, 80, 160, 320]))}`,
    `link:${String(bucket(caseResult.linkCount, [0, 1, 3, 8]))}`,
    `text:${String(bucket(caseResult.visibleTextLength, [0, 40, 120, 320, 800]))}`,
    `ids:${parseErrorGroup.length > 0 ? parseErrorGroup : "none"}`,
    `table:${String(hasPattern(html, /<table[\s>]/i))}`,
    `list:${String(hasPattern(html, /<(ul|ol|li)[\s>]/i))}`,
    `form:${String(hasPattern(html, /<(form|input|button|textarea|select)[\s>]/i))}`,
    `hidden:${String(hasPattern(html, /\shidden(?:\s|>|=)/i))}`,
    `details:${String(hasPattern(html, /<(details|summary)[\s>]/i))}`,
    `pre:${String(hasPattern(html, /<(pre|code)[\s>]/i))}`
  ];
  return signature.join("|");
}

export function getGuidedFuzzPolicy(config, profile) {
  const defaults = profile === "release"
    ? {
        seed: 20260227,
        initialCorpusSize: 32,
        maxDepth: 6,
        sectionCount: 10,
        maxIterations: 160,
        mutationsPerInput: 2,
        frontierLimit: 80,
        topSlowest: 20,
        minNovelSignatures: 18
      }
    : {
        seed: 20260227,
        initialCorpusSize: 16,
        maxDepth: 5,
        sectionCount: 8,
        maxIterations: 48,
        mutationsPerInput: 2,
        frontierLimit: 40,
        topSlowest: 10,
        minNovelSignatures: 12
      };

  const override = config?.fuzzGuided?.profiles?.[profile] ?? {};
  return {
    seed: Number.isSafeInteger(override.seed) ? override.seed : defaults.seed,
    initialCorpusSize: Number.isSafeInteger(override.initialCorpusSize)
      ? override.initialCorpusSize
      : defaults.initialCorpusSize,
    maxDepth: Number.isSafeInteger(override.maxDepth) ? override.maxDepth : defaults.maxDepth,
    sectionCount: Number.isSafeInteger(override.sectionCount) ? override.sectionCount : defaults.sectionCount,
    maxIterations: Number.isSafeInteger(override.maxIterations) ? override.maxIterations : defaults.maxIterations,
    mutationsPerInput: Number.isSafeInteger(override.mutationsPerInput)
      ? override.mutationsPerInput
      : defaults.mutationsPerInput,
    frontierLimit: Number.isSafeInteger(override.frontierLimit) ? override.frontierLimit : defaults.frontierLimit,
    topSlowest: Number.isSafeInteger(override.topSlowest) ? override.topSlowest : defaults.topSlowest,
    minNovelSignatures: Number.isSafeInteger(override.minNovelSignatures)
      ? override.minNovelSignatures
      : defaults.minNovelSignatures
  };
}

export function runGuidedFuzz(policy, profile) {
  const rng = createRng(policy.seed);
  const frontier = [];
  const seenSignatures = new Set();
  const deterministicMismatches = [];
  const crashes = [];
  const durations = [];
  const slowest = [];
  const novelFindings = [];

  let caseCounter = 0;

  for (let index = 0; index < policy.initialCorpusSize; index += 1) {
    const seed = policy.seed + index;
    frontier.push({
      seed,
      html: generateFuzzHtml(seed, {
        maxDepth: policy.maxDepth,
        sectionCount: policy.sectionCount
      })
    });
  }

  const executeCase = (seed, html) => {
    caseCounter += 1;
    const caseId = `fuzz-guided-${profile}-${String(caseCounter).padStart(4, "0")}`;
    const caseEntry = { caseId, seed, html };
    const start = performance.now();
    try {
      const first = evaluateFuzzCase(caseEntry);
      const second = evaluateFuzzCase(caseEntry);
      const durationMs = performance.now() - start;
      durations.push(durationMs);
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        deterministicMismatches.push({ caseId, seed, first, second });
      }
      const signature = signatureFromCaseResult(first, html);
      const isNovel = !seenSignatures.has(signature);
      if (isNovel) {
        seenSignatures.add(signature);
        novelFindings.push({
          caseId,
          seed,
          signature,
          parseErrorCount: first.parseErrorCount,
          lineCount: first.lineCount,
          linkCount: first.linkCount
        });
      }
      slowest.push({
        caseId,
        seed,
        durationMs: Number(durationMs.toFixed(6)),
        parseErrorCount: first.parseErrorCount,
        lineCount: first.lineCount,
        linkCount: first.linkCount,
        novel: isNovel
      });
      if (isNovel && frontier.length < policy.frontierLimit) {
        frontier.push({ seed, html });
      }
    } catch (error) {
      const durationMs = performance.now() - start;
      durations.push(durationMs);
      crashes.push({
        caseId,
        seed,
        durationMs: Number(durationMs.toFixed(6)),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };

  for (let index = 0; index < frontier.length; index += 1) {
    executeCase(frontier[index].seed, frontier[index].html);
  }

  for (let iteration = 0; iteration < policy.maxIterations; iteration += 1) {
    if (frontier.length === 0) {
      break;
    }
    const parent = frontier[pickIndex(rng, frontier.length)] ?? frontier[0];
    for (let mutationIndex = 0; mutationIndex < policy.mutationsPerInput; mutationIndex += 1) {
      const seed = policy.seed + policy.initialCorpusSize + iteration * policy.mutationsPerInput + mutationIndex;
      const html = mutateHtml(parent.html, rng);
      executeCase(seed, html);
    }
  }

  slowest.sort((left, right) => right.durationMs - left.durationMs);

  const p50Index = durations.length === 0 ? 0 : Math.floor(0.5 * (durations.length - 1));
  const p95Index = durations.length === 0 ? 0 : Math.floor(0.95 * (durations.length - 1));
  const sortedDurations = [...durations].sort((left, right) => left - right);

  const report = {
    suite: "fuzz-guided",
    timestamp: new Date().toISOString(),
    profile,
    policy,
    totals: {
      executedCases: caseCounter,
      novelSignatures: seenSignatures.size,
      crashes: crashes.length,
      deterministicMismatches: deterministicMismatches.length
    },
    coverage: {
      uniqueSignatures: seenSignatures.size,
      noveltyRate: caseCounter === 0 ? 0 : Number((seenSignatures.size / caseCounter).toFixed(6)),
      minNovelSignaturesRequired: policy.minNovelSignatures
    },
    timing: {
      p50Ms: Number((sortedDurations[p50Index] ?? 0).toFixed(6)),
      p95Ms: Number((sortedDurations[p95Index] ?? 0).toFixed(6)),
      maxMs: Number((sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1] : 0).toFixed(6))
    },
    topSlowest: slowest.slice(0, policy.topSlowest),
    topNovelFindings: novelFindings.slice(0, 40),
    crashes,
    deterministicMismatches,
    ok:
      crashes.length === 0
      && deterministicMismatches.length === 0
      && seenSignatures.size >= policy.minNovelSignatures
  };

  return report;
}
