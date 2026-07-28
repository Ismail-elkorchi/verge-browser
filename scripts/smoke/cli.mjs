import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function createFixture() {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "verge-browser-smoke-"));
  await writeFile(join(fixtureDirectory, "index.html"), `
    <html>
      <head><title>Index</title></head>
      <body>
        <h1>Index</h1>
        <p><a href="./next.html">Next page</a></p>
      </body>
    </html>
  `, "utf8");
  await writeFile(join(fixtureDirectory, "next.html"), `
    <html>
      <head><title>Next</title></head>
      <body>
        <h1>Next</h1>
        <p>Second page</p>
      </body>
    </html>
  `, "utf8");
  return fixtureDirectory;
}

async function runSmokeCheck() {
  const fixtureDirectory = await createFixture();
  const target = `file://${fixtureDirectory}/index.html`;

  try {
    const once = spawnSync(process.execPath, ["dist/cli.js", "--once", target], {
      encoding: "utf8",
      timeout: 8_000
    });
    if (once.status !== 0) {
      throw new Error(`CLI --once failed with exit code ${String(once.status)}\n${once.stderr}`);
    }
    if (!once.stdout.includes("Index") || !once.stdout.includes("Next page")) {
      throw new Error("CLI --once did not render the initial document.");
    }
    if (!once.stdout.includes(target) || once.stdout.indexOf(target) > once.stdout.indexOf("# Index")) {
      throw new Error("CLI --once did not render browser chrome before the document.");
    }
    if (once.stdout.includes("\u001b")) {
      throw new Error("CLI --once emitted terminal control sequences.");
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

try {
  await runSmokeCheck();
  const invalidOption = spawnSync(process.execPath, ["dist/cli.js", "--unknown-option"], {
    encoding: "utf8"
  });
  if (invalidOption.status !== 1 || !invalidOption.stderr.includes("Unknown option: --unknown-option")) {
    throw new Error("CLI did not reject an unknown option");
  }
  process.stdout.write("cli smoke ok\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cli-smoke failed: ${message}\n`);
  process.exit(1);
}
