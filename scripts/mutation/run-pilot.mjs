import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const options = {
    config: "scripts/mutation/pilot-config.json",
    out: "docs/maintainers/mutation-pilot-report.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [flag, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue == null) {
      index += 1;
    }

    if (flag === "--config" && value) {
      options.config = value;
      continue;
    }

    if (flag === "--out" && value) {
      options.out = value;
    }
  }

  return options;
}

function runCommand(command, cwd) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function applySingleReplace(source, search, replace) {
  const firstIndex = source.indexOf(search);
  if (firstIndex === -1) {
    return { ok: false, value: source, reason: "search-not-found" };
  }

  const secondIndex = source.indexOf(search, firstIndex + search.length);
  if (secondIndex !== -1) {
    return { ok: false, value: source, reason: "search-not-unique" };
  }

  return {
    ok: true,
    value: `${source.slice(0, firstIndex)}${replace}${source.slice(firstIndex + search.length)}`,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const configPath = path.resolve(repoRoot, args.config);
  const outPath = path.resolve(repoRoot, args.out);

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const targetPath = path.resolve(repoRoot, config.targetFile);
  const originalSource = fs.readFileSync(targetPath, "utf8");

  const report = {
    schema: "mutation-pilot/v1",
    generatedAt: new Date().toISOString(),
    config: path.relative(repoRoot, configPath).split(path.sep).join("/"),
    targetFile: path.relative(repoRoot, targetPath).split(path.sep).join("/"),
    testCommand: config.testCommand,
    mutants: [],
    totals: {
      total: 0,
      killed: 0,
      survived: 0,
      invalid: 0,
    },
  };

  try {
    for (const mutant of config.mutants) {
      report.totals.total += 1;
      const applied = applySingleReplace(originalSource, mutant.search, mutant.replace);
      if (!applied.ok) {
        report.totals.invalid += 1;
        report.mutants.push({
          id: mutant.id,
          description: mutant.description,
          status: "invalid",
          reason: applied.reason,
        });
        continue;
      }

      fs.writeFileSync(targetPath, applied.value, "utf8");
      const execution = runCommand(config.testCommand, repoRoot);
      const status = execution.status === 0 ? "survived" : "killed";
      if (status === "survived") {
        report.totals.survived += 1;
      } else {
        report.totals.killed += 1;
      }

      report.mutants.push({
        id: mutant.id,
        description: mutant.description,
        status,
        testExitCode: execution.status,
      });
    }
  } finally {
    fs.writeFileSync(targetPath, originalSource, "utf8");
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const score =
    report.totals.total === 0
      ? 0
      : Number(((report.totals.killed / report.totals.total) * 100).toFixed(2));
  process.stdout.write(
    `mutation-pilot complete: total=${report.totals.total} killed=${report.totals.killed} survived=${report.totals.survived} invalid=${report.totals.invalid} score=${score}\n`,
  );
}

main();
