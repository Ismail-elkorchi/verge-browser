import { readFile } from "node:fs/promises";

const reportPaths = [
  "reports/smoke-node.json",
  "reports/smoke-deno.json",
  "reports/smoke-bun.json"
];

const reports = await Promise.all(
  reportPaths.map(async (path) => {
    const report = JSON.parse(await readFile(path, "utf8"));
    if (report?.ok !== true || typeof report.runtime !== "string" || typeof report.hash !== "string") {
      throw new Error(`invalid or failed runtime smoke report: ${path}`);
    }
    return report;
  })
);

const expectedHash = reports[0].hash;
const mismatches = reports.filter((report) => report.hash !== expectedHash);
if (mismatches.length > 0) {
  const observed = reports.map((report) => `${report.runtime}=${report.hash}`).join(", ");
  throw new Error(`runtime outputs differ: ${observed}`);
}

process.stdout.write(`runtime parity ok: ${reports.map((report) => report.runtime).join(", ")}\n`);
