import { refreshOracleLock } from "./real-oracle-lib.mjs";

async function main() {
  const result = await refreshOracleLock();
  process.stdout.write(
    `oracle lock refreshed: ${result.lockPath} (packages=${String(result.packageCount)}, fingerprint=${result.fingerprint})\n`
  );
}

await main();
