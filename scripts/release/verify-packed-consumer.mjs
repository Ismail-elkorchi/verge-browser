import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  HTML_PARSER_PACKAGE_NAME,
  validateParserPackageContract
} from "./parser-package-contract.mjs";

const HTTP_CLIENT_PACKAGE_NAME = "@ismail-elkorchi/http-client";

function run(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = capture
      ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      : "";
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}${details}`);
  }
  return result.stdout;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function verifyPackedFiles(packEntry) {
  const paths = Array.isArray(packEntry.files)
    ? packEntry.files
      .map((file) => file?.path)
      .filter((path) => typeof path === "string")
    : [];
  const requiredPaths = [
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/mod.d.ts",
    "dist/mod.js",
    "package.json"
  ];
  const missingPaths = requiredPaths.filter((path) => !paths.includes(path));
  const unexpectedPaths = paths.filter(
    (path) =>
      path !== "LICENSE"
      && path !== "README.md"
      && path !== "package.json"
      && !path.startsWith("dist/")
  );

  if (missingPaths.length > 0 || unexpectedPaths.length > 0) {
    throw new Error(
      `invalid packed file set: missing=${missingPaths.join(",") || "none"} unexpected=${unexpectedPaths.join(",") || "none"}`
    );
  }

  return paths.length;
}

const root = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), "verge-packed-consumer-"));

try {
  const workspaceManifest = await readJson(resolve(root, "package.json"));
  const packOutput = run(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    { cwd: root, capture: true }
  );
  const packEntries = JSON.parse(packOutput);
  const packed = Array.isArray(packEntries) ? packEntries[0] : undefined;
  if (packed === undefined || typeof packed.filename !== "string") {
    throw new Error("npm pack did not report the packed Verge artifact");
  }
  const packedFileCount = verifyPackedFiles(packed);

  const tarballPath = join(temporaryRoot, basename(packed.filename));
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({
      name: "verge-packed-consumer",
      private: true,
      type: "module",
      dependencies: {
        "@ismail-elkorchi/verge-browser": pathToFileURL(tarballPath).href
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "smoke.mjs"),
    `import {
  PageNetworkClient,
  parseHtml,
  renderDocumentToTerminal
} from "@ismail-elkorchi/verge-browser";

const document = parseHtml("<main><h1>Packed consumer</h1><p>Public parser.</p></main>");
const networkClient = new PageNetworkClient();
await networkClient.close();
if (
  document.tree.kind !== "document" ||
  document.metadata.inputKind !== "text" ||
  document.metadata.resourceUsage.nodes < 1
) {
  throw new Error("parseHtml did not return a ParsedDocument");
}
const rendered = renderDocumentToTerminal({
  tree: document.tree,
  requestUrl: "https://example.test",
  finalUrl: "https://example.test",
  status: 200,
  statusText: "OK",
  fetchedAtIso: "2026-01-01T00:00:00.000Z",
  width: 80
});
if (!rendered.lines.join("\\n").includes("Packed consumer")) {
  throw new Error("packed Verge runtime did not render parsed content");
}
`,
    "utf8"
  );

  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org"
    ],
    { cwd: consumerRoot }
  );

  const installedVerge = await readJson(
    join(
      consumerRoot,
      "node_modules",
      "@ismail-elkorchi",
      "verge-browser",
      "package.json"
    )
  );
  if (installedVerge.version !== workspaceManifest.version) {
    throw new Error(
      `packed Verge version ${String(installedVerge.version)} does not match ${String(workspaceManifest.version)}`
    );
  }

  const consumerLock = await readJson(join(consumerRoot, "package-lock.json"));
  const installedParser = await readJson(
    join(
      consumerRoot,
      "node_modules",
      "@ismail-elkorchi",
      "html-parser",
      "package.json"
    )
  );
  const parserEvidence = validateParserPackageContract({
    dependencySpec: installedVerge.dependencies?.[HTML_PARSER_PACKAGE_NAME],
    lockEntry: consumerLock.packages?.[`node_modules/${HTML_PARSER_PACKAGE_NAME}`],
    installedManifest: installedParser
  });
  const installedHttpClient = await readJson(
    join(
      consumerRoot,
      "node_modules",
      "@ismail-elkorchi",
      "http-client",
      "package.json"
    )
  );
  if (
    installedHttpClient.name !== HTTP_CLIENT_PACKAGE_NAME
    || installedVerge.dependencies?.[HTTP_CLIENT_PACKAGE_NAME]
      !== workspaceManifest.dependencies?.[HTTP_CLIENT_PACKAGE_NAME]
    || consumerLock.packages?.[`node_modules/${HTTP_CLIENT_PACKAGE_NAME}`]?.version
      !== installedHttpClient.version
  ) {
    throw new Error("packed Verge does not install its declared http-client release");
  }

  run(process.execPath, ["smoke.mjs"], { cwd: consumerRoot });
  process.stdout.write(
    `packed consumer verified: ${workspaceManifest.name}@${workspaceManifest.version} (${String(packedFileCount)} files) -> ` +
      `${parserEvidence.name}@${parserEvidence.version} ${parserEvidence.integrity}; `
      + `${installedHttpClient.name}@${installedHttpClient.version}\n`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
