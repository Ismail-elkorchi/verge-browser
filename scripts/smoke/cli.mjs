import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TIMEOUT_MS = 8_000;

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
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/cli.js", target], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let step = "initial-page";
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        reject(
          new Error(
            `CLI smoke timed out at ${step} after ${String(TIMEOUT_MS)}ms\n${stderrBuffer}`
          )
        );
      }, TIMEOUT_MS);

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        child.kill("SIGKILL");
        reject(error);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;

        if (step === "initial-page" && stdoutBuffer.includes("Index")) {
          step = "linked-page";
          child.stdin.write("]\r");
          return;
        }

        if (step === "linked-page" && stdoutBuffer.includes("Second page")) {
          step = "back-navigation";
          child.stdin.write("h");
          return;
        }

        if (step === "back-navigation" && stdoutBuffer.includes("Back ->")) {
          step = "exit";
          child.stdin.end("q");
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
      });

      child.on("error", (error) => {
        fail(error);
      });

      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        if (signal !== null) {
          reject(new Error(`CLI smoke terminated by signal ${signal}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`CLI smoke failed with exit code ${String(code)}\n${stderrBuffer}`));
          return;
        }
        if (step !== "exit") {
          reject(new Error(`CLI smoke exited before completing ${step}`));
          return;
        }
        resolve(undefined);
      });
    });
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
