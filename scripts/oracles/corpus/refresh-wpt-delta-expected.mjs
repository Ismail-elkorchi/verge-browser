import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { evaluateWptDeltaCase, readWptDeltaCorpus } from "../../eval/wpt-delta-lib.mjs";

async function main() {
  const corpusPath = resolve("scripts/oracles/corpus/wpt-delta-v1.json");
  const outputPath = resolve("scripts/oracles/corpus/wpt-delta-v1.expected.json");

  const corpus = await readWptDeltaCorpus(corpusPath);
  const cases = corpus.cases.map((entry) => evaluateWptDeltaCase(entry));

  const payload = {
    suite: "wpt-delta-expected",
    version: 1,
    generatedAtIso: new Date().toISOString(),
    source: {
      repository: corpus.source?.repository ?? null,
      commit: corpus.source?.commit ?? null
    },
    cases: cases
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${outputPath} with ${String(payload.cases.length)} cases\n`);
}

await main();
