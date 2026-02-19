import { refreshOracleLock } from "./real-oracle-lib.mjs";

function parseArgs(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument.startsWith("--snapshot-id=")) {
      options.snapshotId = argument.slice("--snapshot-id=".length).trim();
      continue;
    }
    if (argument.startsWith("--snapshot-root=")) {
      options.snapshotRoot = argument.slice("--snapshot-root=".length).trim();
      continue;
    }
    if (argument.startsWith("--keyring-path=")) {
      options.keyringPath = argument.slice("--keyring-path=".length).trim();
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await refreshOracleLock(options);
  process.stdout.write(
    `oracle lock refreshed: ${result.lockPath} (snapshot=${result.snapshotId}, packages=${String(result.packageCount)}, fingerprint=${result.fingerprint})\n`
  );
}

await main();
