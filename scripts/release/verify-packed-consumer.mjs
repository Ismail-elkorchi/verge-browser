import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  HTML_PARSER_PACKAGE_NAME,
  validateParserPackageContract
} from "./parser-package-contract.mjs";

const SHARED_RUNTIME_DEPENDENCIES = Object.freeze([
  "@ismail-elkorchi/css-parser",
  "@ismail-elkorchi/http-client",
  "@ismail-elkorchi/terminal-ui"
]);

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

async function validateInstalledDependency(name, installedVerge, workspaceManifest, consumerLock, consumerRoot) {
  const installed = await readJson(join(consumerRoot, "node_modules", ...name.split("/"), "package.json"));
  const declared = installedVerge.dependencies?.[name];
  const locked = consumerLock.packages?.[`node_modules/${name}`];
  if (
    typeof declared !== "string"
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(declared)
    || declared !== workspaceManifest.dependencies?.[name]
    || installed.name !== name
    || locked?.version !== installed.version
    || locked.version !== declared
    || typeof locked.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(locked.integrity)
  ) {
    throw new Error(`packed Verge does not install its declared ${name} release`);
  }
  return { name, version: installed.version };
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
      },
      devDependencies: {
        "@types/node": workspaceManifest.devDependencies["@types/node"],
        "typescript": workspaceManifest.devDependencies.typescript
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "smoke.ts"),
    `import {
  BrowserSession,
  fetchPage,
  parseWebDocument,
  type PageSnapshot,
  type WebDocumentParseOptions,
  type WebDocumentSnapshotView
} from "@ismail-elkorchi/verge-browser";

const parseOptions: WebDocumentParseOptions = {
  budgets: { maxInputBytes: 1024, maxNodes: 100 }
};
const document: WebDocumentSnapshotView = parseWebDocument(
  "<main><h1>Typed consumer</h1></main>",
  { requestUrl: "https://example.test/", finalUrl: "https://example.test/" },
  parseOptions
);
const session = new BrowserSession({
  defaultParseMode: "text",
  loader: async (requestUrl) => {
    const page = await fetchPage("about:help");
    return { ...page, requestUrl, finalUrl: requestUrl };
  }
});
const snapshot: PageSnapshot = await session.open("https://example.test/");
if (document.root.length === 0 || snapshot.document.root.length === 0) throw new Error("invalid document");
await session.close();
`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"]
      },
      include: ["smoke.ts"]
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "smoke.mjs"),
    `import {
  BrowserSession,
  PageNetworkClient,
  fetchPage,
  parseWebDocument
} from "@ismail-elkorchi/verge-browser";

const document = parseWebDocument(
  "<main><h1>Packed consumer</h1><p>Public document.</p><a href='/next'>Next</a></main>",
  { requestUrl: "https://example.test/", finalUrl: "https://example.test/" }
);
const networkClient = new PageNetworkClient();
await networkClient.close();
if (
  document.node(document.root).kind !== "document" ||
  document.sourceMetadata.inputKind !== "text" ||
  document.links[0]?.destination !== "https://example.test/next"
) {
  throw new Error("parseWebDocument did not return the documented semantic snapshot");
}
const session = new BrowserSession({
  loader: async (requestUrl) => {
    const page = await fetchPage("about:help");
    return { ...page, requestUrl, finalUrl: requestUrl };
  },
  defaultParseMode: "text"
});
const snapshot = await session.open("https://example.test/");
if (snapshot.document.root.length === 0) throw new Error("packed session did not expose a document snapshot");
await session.close();
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
  const sharedDependencies = await Promise.all(SHARED_RUNTIME_DEPENDENCIES.map((name) =>
    validateInstalledDependency(name, installedVerge, workspaceManifest, consumerLock, consumerRoot)
  ));

  run(process.execPath, ["smoke.mjs"], { cwd: consumerRoot });
  run("npx", ["--no-install", "tsc", "-p", "tsconfig.json"], { cwd: consumerRoot });
  process.stdout.write(
    `packed consumer verified: ${workspaceManifest.name}@${workspaceManifest.version} (${String(packedFileCount)} files) -> ` +
      `${parserEvidence.name}@${parserEvidence.version} ${parserEvidence.integrity}; `
      + `${sharedDependencies.map((entry) => `${entry.name}@${entry.version}`).join("; ")}\n`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
