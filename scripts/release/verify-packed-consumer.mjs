import { validateDependencyInstall } from "./dependency-package-contract.mjs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHARED_RUNTIME_DEPENDENCIES = Object.freeze([
  "@ismail-elkorchi/html-parser",
  "@ismail-elkorchi/css-parser",
  "@ismail-elkorchi/http-client",
  "@ismail-elkorchi/terminal-ui"
]);

function run(command, args, { cwd, capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
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
    "dist/ui/render-worker/worker-entry.js",
    "dist/ui/render-worker/client.js",
    "dist/ui/render-worker/protocol.js",
    "dist/runtime/image-decoder-entry.js",
    "dist/runtime/image-decoder.js",
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
  if (declared !== workspaceManifest.dependencies?.[name]) {
    throw new Error(`packed Verge changed its declared ${name} dependency`);
  }
  const installedLock = await readJson(join(consumerRoot, "node_modules", ".package-lock.json"));
  return validateDependencyInstall({
    name,
    dependencySpec: declared,
    lockEntry: consumerLock.packages?.[`node_modules/${name}`],
    installedManifest: installed,
    installedLockEntry: installedLock.packages?.[`node_modules/${name}`]
  });
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
  PageNetworkClient,
  fetchPage,
  type FetchImageResult,
  type ImageRequestOptions,
  type PageSnapshot,
  type WebDocumentSnapshot
} from "@ismail-elkorchi/verge-browser";

const session = new BrowserSession({
  defaultParseMode: "text",
  loader: async (requestUrl) => {
    const page = await fetchPage("about:help");
    return { ...page, requestUrl, finalUrl: requestUrl };
  }
});
const snapshot: PageSnapshot = await session.open("https://example.test/");
const document: WebDocumentSnapshot = snapshot.document;
const imageOptions: ImageRequestOptions = { maxContentBytes: 1024, maxRedirects: 2, timeoutMs: 1000 };
const imageFetch: (url: string, documentUrl: string, options: ImageRequestOptions) => Promise<FetchImageResult>
  = PageNetworkClient.prototype.fetchImage;
void imageOptions;
void imageFetch;
// @ts-expect-error Progressive pixels are private to the interactive snapshot.
snapshot.images;
// @ts-expect-error BrowserSession does not own progressive image configuration.
new BrowserSession({ imagePolicy: { maxPixels: 1 } });
// @ts-expect-error Decoder ownership is not part of the public package API.
type PrivatePixels = import("@ismail-elkorchi/verge-browser").DocumentImageResource;
if (document.root.length === 0) throw new Error("invalid document");
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
  fetchPage
} from "@ismail-elkorchi/verge-browser";
const networkClient = new PageNetworkClient();
await networkClient.close();
const session = new BrowserSession({
  loader: async (requestUrl) => {
    const page = await fetchPage("about:help");
    return { ...page, requestUrl, finalUrl: requestUrl };
  },
  defaultParseMode: "text"
});
const snapshot = await session.open("https://example.test/");
if (
  snapshot.document.root.length === 0 ||
  snapshot.document.node(snapshot.document.root).kind !== "document"
) throw new Error("packed session did not expose a document snapshot");
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
  const sharedDependencies = await Promise.all(SHARED_RUNTIME_DEPENDENCIES.map((name) =>
    validateInstalledDependency(name, installedVerge, workspaceManifest, consumerLock, consumerRoot)
  ));

  run(process.execPath, ["smoke.mjs"], { cwd: consumerRoot });
  const fixture = join(temporaryRoot, "worker.html");
  await writeFile(fixture, "<title>Packed worker</title><p>packed-worker-verified</p>", "utf8");
  const viewport = run(process.execPath, [
    "node_modules/@ismail-elkorchi/verge-browser/dist/cli.js", "--once", pathToFileURL(fixture).href,
  ], { cwd: consumerRoot, capture: true, env: { ...process.env, XDG_STATE_HOME: join(temporaryRoot, "state") } });
  if (!viewport.includes("packed-worker-verified") || viewport.includes("Rendering failed")) {
    throw new Error("packed consumer did not render through its worker entrypoint");
  }
  run("npx", ["--no-install", "tsc", "-p", "tsconfig.json"], { cwd: consumerRoot });
  process.stdout.write(
    `packed consumer verified: ${workspaceManifest.name}@${workspaceManifest.version} (${String(packedFileCount)} files) -> ` +
      `${sharedDependencies.map((entry) => `${entry.name}@${entry.revision ?? entry.version}`).join("; ")}\n`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
