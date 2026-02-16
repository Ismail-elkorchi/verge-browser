# Phase 4 parse-error taxonomy rehearsal

## Objective
Use `parseErrorId` from `html-parser` in local mismatch triage output.

## Commands
1. Corpus mismatch sample (CI profile corpus):
```bash
node --input-type=module <<'NODE'
import { resolve } from 'node:path';
import { parse } from 'html-parser';
import { runRenderEvaluation, readJson } from './scripts/eval/render-eval-lib.mjs';

const configPath = resolve('evaluation.config.json');
const corpusPath = resolve('scripts/oracles/corpus/render-v3.json');
const [config, corpus] = await Promise.all([readJson(configPath), readJson(corpusPath)]);
const evaluation = await runRenderEvaluation({ config, corpus, profile: 'ci' });
const caseById = new Map(corpus.cases.map((entry) => [entry.id, entry]));
const mismatch = evaluation.vergeReport.cases.find((entry) =>
  entry.metrics.textTokenF1 < 1 || entry.metrics.linkLabelF1 < 1 || entry.metrics.tableMatrixF1 < 1 || entry.metrics.outlineF1 < 1
);
const source = caseById.get(mismatch.id);
const parsed = parse(source.html, { trace: true });
console.log(JSON.stringify({
  caseId: mismatch.id,
  width: mismatch.width,
  metrics: mismatch.metrics,
  parseErrorIds: parsed.errors.map((entry) => entry.parseErrorId),
  parseErrorCount: parsed.errors.length
}, null, 2));
NODE
```

2. Malformed triage sample (explicit failing condition: `parseErrorCount > 0`):
```bash
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'html-parser';
import { runRenderEvaluation, readJson } from './scripts/eval/render-eval-lib.mjs';

const config = await readJson(resolve('evaluation.config.json'));
const html = '<table><tr><td>A<td>B</tr></span>';
const widths = config.render.widths;
const sha256 = createHash('sha256').update(html).digest('hex');
const corpus = {
  suite: 'phase4-triage',
  cases: [{ id: 'phase4-malformed-0001', html, sha256, widths }]
};
const evaluation = await runRenderEvaluation({ config, corpus, profile: 'ci', minimumCorpusCases: 1 });
const caseReport = evaluation.vergeReport.cases[0];
const parsed = parse(html, { trace: true });
const parseErrorIds = parsed.errors.map((entry) => entry.parseErrorId);
console.log(JSON.stringify({
  caseId: caseReport.id,
  metrics: caseReport.metrics,
  parseErrorIds,
  parseErrorCount: parsed.errors.length,
  failsOnParseErrors: parsed.errors.length > 0
}, null, 2));
NODE
```

## Observed triage payloads
- Corpus mismatch case:
```json
{
  "caseId": "render-v3-0004",
  "width": 60,
  "metrics": {
    "textTokenF1": 0.9629629629629629,
    "linkLabelF1": 1,
    "tableMatrixF1": 1,
    "preWhitespaceExact": 1,
    "outlineF1": 1
  },
  "parseErrorIds": [],
  "parseErrorCount": 0
}
```

- Malformed triage case:
```json
{
  "caseId": "phase4-malformed-0001",
  "metrics": {
    "textTokenF1": 1,
    "linkLabelF1": 1,
    "tableMatrixF1": 1,
    "preWhitespaceExact": 1,
    "outlineF1": 1
  },
  "parseErrorIds": [
    "missing-doctype"
  ],
  "parseErrorCount": 1,
  "failsOnParseErrors": true
}
```
