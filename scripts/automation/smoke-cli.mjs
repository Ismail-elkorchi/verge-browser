import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const timeoutMs = 8_000;

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmokeCheck() {
  const fixtureDirectory = await createFixture();
  const target = `file://${fixtureDirectory}/index.html`;

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/cli.js", target], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";

      const timeoutHandle = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`CLI smoke timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
      });

      child.on("error", (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timeoutHandle);
        if (signal !== null) {
          reject(new Error(`CLI smoke terminated by signal ${signal}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`CLI smoke failed with exit code ${String(code)}\n${stderrBuffer}`));
          return;
        }
        if (!stdoutBuffer.includes("Index")) {
          reject(new Error("CLI smoke did not render the initial page"));
          return;
        }
        if (!stdoutBuffer.includes("Next")) {
          reject(new Error("CLI smoke did not navigate to the linked page"));
          return;
        }
        if (!stdoutBuffer.includes("Back ->")) {
          reject(new Error("CLI smoke did not navigate back"));
          return;
        }
        resolve(undefined);
      });

      (async () => {
        await wait(150);
        child.stdin.write("]");
        await wait(150);
        child.stdin.write("\r");
        await wait(150);
        child.stdin.write("h");
        await wait(150);
        child.stdin.write("q");
        child.stdin.end();
      })().catch((error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
    });
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

try {
  await runSmokeCheck();
  process.stdout.write("cli-smoke ok\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cli-smoke failed: ${message}\n`);
  process.exit(1);
}
