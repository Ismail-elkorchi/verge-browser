# Span provenance rehearsal

## Objective
Validate that patch workflows in `html-parser` succeed on input spans and reject non-input spans with a structured failure payload.

## Command
```bash
node --input-type=module <<'NODE'
import { applyPatchPlan, computePatch, parse, PatchPlanningError } from '/home/ismail-el-korchi/Documents/Projects/html-parser/dist/mod.js';

function findNode(nodes, predicate) {
  for (const node of nodes) {
    if (predicate(node)) return node;
    if (node.kind === 'element') {
      const nested = findNode(node.children, predicate);
      if (nested) return nested;
    }
  }
  return null;
}

const source = '<div><p class="x">one</p><p>two</p></div>';
const tree = parse(source, { captureSpans: true });
const paragraph = findNode(tree.children, (node) => node.kind === 'element' && node.tagName === 'p');
const textNode = paragraph?.kind === 'element' ? findNode(paragraph.children, (node) => node.kind === 'text') : null;
const patch = computePatch(source, [
  { kind: 'replaceText', target: textNode.id, value: 'uno' },
  { kind: 'setAttr', target: paragraph.id, name: 'class', value: 'y' }
]);
const patched = applyPatchPlan(source, patch);

const inferredTree = parse('<p>x</p>', { captureSpans: true });
const inferred = findNode(
  inferredTree.children,
  (node) => node.kind === 'element' && (node.tagName === 'html' || node.tagName === 'body') && node.spanProvenance !== 'input'
);

let rejection = null;
try {
  computePatch('<p>x</p>', [{ kind: 'removeNode', target: inferred.id }]);
} catch (error) {
  if (error instanceof PatchPlanningError) {
    rejection = {
      code: error.payload.code,
      detail: error.payload.detail,
      target: error.payload.target
    };
  }
}

console.log(JSON.stringify({
  patchSuccess: patched === '<div><p class="y">uno</p><p>two</p></div>',
  patched,
  inferredSpanProvenance: inferred?.spanProvenance ?? null,
  rejection
}, null, 2));
NODE
```

## Output
```json
{
  "patchSuccess": true,
  "patched": "<div><p class=\"y\">uno</p><p>two</p></div>",
  "inferredSpanProvenance": "inferred",
  "rejection": {
    "code": "NON_INPUT_SPAN_PROVENANCE",
    "detail": "inferred",
    "target": 6
  }
}
```
