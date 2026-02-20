import { ensureOracleImage } from "./real-oracle-lib.mjs";

function parseArgs(argv) {
  return {
    rebuildLock: argv.includes("--rebuild-lock")
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const imageState = await ensureOracleImage({
    rebuildLock: options.rebuildLock
  });
  process.stdout.write(
    `oracle image ready: fingerprint=${imageState.fingerprint} packages=${String(imageState.packageCount)} rootfs=${imageState.rootfsPath}\n`
  );
}

await main();
