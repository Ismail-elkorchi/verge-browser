import { spawn } from "node:child_process";

const timeoutMs = 8_000;

function runSmokeCheck() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", "about:help"], {
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
      if (!stdoutBuffer.includes("verge-browser help")) {
        reject(new Error("CLI smoke did not render expected help heading"));
        return;
      }
      resolve(undefined);
    });

    child.stdin.write("q");
    child.stdin.end();
  });
}

try {
  await runSmokeCheck();
  process.stdout.write("cli-smoke ok\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cli-smoke failed: ${message}\n`);
  process.exit(1);
}
