import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";

import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { createTuiRuntime } from "@ismail-elkorchi/terminal-ui/tui";

import { BrowserSession } from "../../dist/app/session.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { createDocumentState } from "../../dist/document/index.js";
import { RenderStageMetrics } from "../../dist/presentation/renderer/index.js";
import { prepareBrowserTui } from "../../dist/ui/run.js";
import { RenderWorkerClient } from "../../dist/ui/render-worker/index.js";
import { updateBrowser } from "../../dist/ui/app.js";
import { browserView } from "../../dist/ui/view.js";

const SAMPLE_COUNT = 21;
const LIMITS_MS = Object.freeze({
  warmScrollP95: 100,
  noChangeViewportP95: 100,
  colorDepthOnlyP95: 100,
  browserViewConstructionP95: 33,
  inputStateUpdateWhileRenderingP95: 50,
  mainEventLoopDelayP95: 16,
  firstShell: 500,
});

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

async function elapsed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, milliseconds: performance.now() - started };
}

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
  }
}

function elapsedSync(operation) {
  const started = performance.now();
  const value = operation();
  return { value, milliseconds: performance.now() - started };
}

function authoredLargePage(sectionCount = 2_000) {
  const selectors = [
    "article", "section", "p", "a", "h2", "ul", "li", "table", "td", "th",
  ].flatMap((type, index) => [
    `${type}{color:var(--ink);margin:0}`,
    `.group-${String(index)} ${type}.entry{padding-inline:1ch}`,
    `main > section:nth-child(${String(index + 2)}n+1) ${type}{font-weight:bold}`,
  ]).join("");
  const sections = Array.from({ length: sectionCount }, (_, index) => `
    <section class="group-${String(index % 10)}"><h2 id="heading-${String(index)}">Section ${String(index)}</h2>
      <p class="entry">A deterministic reference paragraph with <a href="/item/${String(index)}">action ${String(index)}</a>
      and enough prose to wrap at narrow terminal widths.</p>
      ${index % 40 === 0 ? `<table><tr><th>Key</th><th>Value</th></tr><tr><td>${String(index)}</td><td>table value</td></tr></table>` : ""}
    </section>`).join("");
  return `<!doctype html><html><head><title>Incremental rendering fixture</title><style>
    :root{--ink:#18231f;--surface:#f5f3ee}body{background:var(--surface)}${selectors}
  </style></head><body><main><h1>Large offline article</h1>${sections}
    <form><label for="query">Query</label><input id="query" value="retained"><button>Submit</button></form>
  </main></body></html>`;
}

function fetchResult(requestUrl, html) {
  return {
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html,
    responseFields: [],
    networkOutcome: {
      kind: "ok", finalUrl: requestUrl, status: 200, statusText: "OK",
      detailCode: "HTTP_200", detailMessage: "200 OK",
    },
    fetchedAtIso: "2026-09-01T00:00:00.000Z",
  };
}

function browserDocument(snapshot, id = "benchmark-document") {
  return {
    id,
    documentRevision: 1,
    stateRevision: 1,
    documentState: createDocumentState(snapshot.document),
    snapshot,
  };
}

function parameters(scrollRow = 0, overrides = {}) {
  return {
    columns: overrides.columns ?? 120,
    rows: overrides.rows ?? 40,
    scrollRow,
    overscanBefore: 6,
    overscanAfter: 12,
    preferences: {
      unicode: true,
      ambiguousWidth: 1,
      colorDepth: overrides.colorDepth ?? 24,
      colorScheme: "dark",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine",
    },
    searchQuery: overrides.searchQuery ?? null,
  };
}

async function workerMeasurements(html) {
  const syntaxMetrics = new RenderStageMetrics();
  const session = new BrowserSession({
    loader: async (requestUrl) => fetchResult(requestUrl, html),
    stylesheetLoader: async () => { throw new Error("unexpected external stylesheet"); },
    defaultParseMode: "text",
    instrumentation: syntaxMetrics,
  });
  const navigation = await elapsed(() => session.open("https://incremental.test/article"));
  const document = browserDocument(navigation.value);
  const client = new RenderWorkerClient();
  let maximumDelay = 0;
  const eventLoopDelays = [];
  let eventLoopPhase = "idle";
  const eventLoopDelayByPhase = new Map();
  let previousTick = performance.now();
  const timer = setInterval(() => {
    const current = performance.now();
    const delay = current - previousTick - 2;
    eventLoopDelays.push(delay);
    maximumDelay = Math.max(maximumDelay, delay);
    eventLoopDelayByPhase.set(eventLoopPhase, Math.max(eventLoopDelayByPhase.get(eventLoopPhase) ?? 0, delay));
    previousTick = current;
  }, 2);
  try {
    eventLoopPhase = "document-attachment";
    const attachment = await elapsed(() => client.attach(document));
    eventLoopPhase = "first-viewport";
    const firstFrame = await elapsed(() => client.renderViewport(document, 1, parameters()));
    eventLoopPhase = "viewport-warmup";
    for (let index = 0; index < 3; index += 1) {
      await client.renderViewport(document, index + 2, parameters((index + 1) * 3));
    }
    const scroll = [];
    const noChange = [];
    const color = [];
    let maximumRows = 0;
    let maximumVisitedCommands = 0;
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      eventLoopPhase = "warm-scroll";
      const next = await elapsed(() => client.renderViewport(document, 10 + index, parameters(30 + index * 3)));
      scroll.push(next.milliseconds);
      maximumRows = Math.max(maximumRows, next.value.cellBuffer.rows.length);
      maximumVisitedCommands = Math.max(
        maximumVisitedCommands,
        next.value.spatialQuery.visitedIntervals,
      );
      eventLoopPhase = "unchanged-viewport";
      noChange.push((await elapsed(() => client.renderViewport(document, 100 + index, parameters(90)))).milliseconds);
      eventLoopPhase = "color-depth";
      color.push((await elapsed(() => client.renderViewport(
        document,
        200 + index,
        parameters(90, { colorDepth: index % 2 === 0 ? 1 : 24 }),
      ))).milliseconds);
    }
    eventLoopPhase = "search";
    const search = await elapsed(() => client.search(document, "reference paragraph", parameters(0), 2_000));
    eventLoopPhase = "resize";
    const resize = await elapsed(() => client.renderViewport(document, 300, parameters(0, { columns: 80 })));
    eventLoopPhase = "replacement-burst";
    const burst = Array.from({ length: 100 }, (_, index) =>
      client.renderViewport(document, 400 + index, parameters(index * 3))
    );
    const burstResults = await Promise.allSettled(burst);
    eventLoopPhase = "metrics-release";
    const metrics = await client.metrics();
    await client.release(document.id);
    const released = await client.metrics();
    return {
      navigationMs: navigation.milliseconds,
      navigationDiagnostics: navigation.value.diagnostics,
      stylesheetSyntaxStages: syntaxMetrics.snapshot(),
      attachmentMs: attachment.milliseconds,
      firstViewportMs: firstFrame.milliseconds,
      firstViewportStages: firstFrame.value.stageMetrics,
      warmScrollP50: percentile(scroll, 0.5),
      warmScrollP95: percentile(scroll, 0.95),
      noChangeViewportP50: percentile(noChange, 0.5),
      noChangeViewportP95: percentile(noChange, 0.95),
      colorDepthOnlyP50: percentile(color, 0.5),
      colorDepthOnlyP95: percentile(color, 0.95),
      searchMs: search.milliseconds,
      resizeMs: resize.milliseconds,
      maximumMainEventLoopDelay: maximumDelay,
      mainEventLoopDelayP95: percentile(eventLoopDelays, 0.95),
      eventLoopDelayByPhase: Object.fromEntries(eventLoopDelayByPhase),
      maximumRetainedRows: maximumRows,
      viewportRowBound: 58,
      maximumSpatialIntervalsVisited: maximumVisitedCommands,
      burstFulfilled: burstResults.filter((result) => result.status === "fulfilled").length,
      burstRejected: burstResults.filter((result) => result.status === "rejected").length,
      workerMetrics: metrics,
      releasedWorkerMetrics: released,
    };
  } finally {
    clearInterval(timer);
    await client.close();
    await session.close();
  }
}

async function tuiMeasurements(html) {
  const directory = await mkdtemp(join(tmpdir(), "verge-incremental-bench-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const uiMetrics = new RenderStageMetrics();
  const preparedAt = performance.now();
  const prepared = await prepareBrowserTui("https://incremental.test/article", {
    store,
    instrumentation: uiMetrics,
    services: {
      async writeTextFile() {}, async downloadFile() { throw new Error("not used"); },
      async openExternal() {}, async openPath() {}, async close() {},
    },
    createSession: () => new BrowserSession({
      loader: async (requestUrl) => fetchResult(requestUrl, html),
      stylesheetLoader: async () => { throw new Error("unexpected external stylesheet"); },
      defaultParseMode: "text",
    }),
  });
  const preparedMs = performance.now() - preparedAt;
  const host = createMemoryTerminalHost({ terminalSize: { columns: 120, rows: 40 } });
  const runtime = createTuiRuntime({ app: prepared.app, host });
  const context = {
    terminalSize: { columns: 120, rows: 40 },
    capabilities: await host.getCapabilities(),
    diagnostics: [],
    clock: host.clock,
  };
  const shell = await elapsed(() => runtime.start());
  const firstFrameStarted = performance.now();
  try {
    await waitUntil(
      () => runtime.state().documents[0]?.rendering?.status === "ready",
      "active page first frame",
    );
    const firstFrameMs = performance.now() - firstFrameStarted;
    const readyDocument = runtime.state().documents[0];
    if (readyDocument?.kind !== "ready") throw new Error("focus benchmark lost its ready document");
    const focusNode = readyDocument.snapshot.document.links[0]?.node;
    if (focusNode === undefined) throw new Error("focus benchmark requires one link");
    const metricsBeforeFocus = await prepared.controller.renderingMetrics();
    const focusInputCommit = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      focusInputCommit.push((await elapsed(() => runtime.dispatch({
        kind: "focusDocumentNode",
        target: index % 2 === 0 ? focusNode : null,
      }))).milliseconds);
    }
    const metricsAfterFocus = await prepared.controller.renderingMetrics();
    if (metricsAfterFocus.viewportRequests !== metricsBeforeFocus.viewportRequests) {
      throw new Error("focus without an author focus selector requested rendering");
    }
    const scrollToViewport = [];
    const scrollInputCommit = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const before = runtime.state().documents[0];
      if (before?.kind !== "ready") throw new Error("scroll benchmark lost its ready document");
      const committedRevision = before.rendering.committedViewportRevision;
      const started = performance.now();
      scrollInputCommit.push((await elapsed(() => runtime.dispatch({ kind: "scroll", rows: 3 }))).milliseconds);
      await waitUntil(() => {
        const current = runtime.state().documents[0];
        return current?.kind === "ready"
          && current.rendering.status === "ready"
          && current.rendering.committedViewportRevision > committedRevision;
      }, "three-row scroll viewport");
      scrollToViewport.push(performance.now() - started);
    }
    const pageDown = await elapsed(() => runtime.dispatch({ kind: "scroll", rows: 10 }));
    const pageUp = await elapsed(() => runtime.dispatch({ kind: "scroll", rows: -10 }));
    const scrollBottom = await elapsed(() => runtime.dispatch({ kind: "scrollBottom" }));
    const scrollTop = await elapsed(() => runtime.dispatch({ kind: "scrollTop" }));
    const viewConstruction = [];
    const frameCommit = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      viewConstruction.push(elapsedSync(() => browserView(runtime.state(), context)).milliseconds);
      frameCommit.push((await elapsed(() => runtime.redraw())).milliseconds);
    }
    const rendering = runtime.resize({ columns: 80, rows: 40 });
    const inputUpdates = [];
    let reducedState = runtime.state();
    for (let index = 0; index < 7; index += 1) {
      const message = {
        kind: index % 2 === 0 ? "openDetail" : "dismiss",
        ...(index % 2 === 0 ? { detail: "help" } : {}),
      };
      const reduced = elapsedSync(() => updateBrowser(prepared.controller, reducedState, message, context));
      reducedState = reduced.value.state;
      inputUpdates.push(reduced.milliseconds);
    }
    const committedInput = [];
    for (let index = 0; index < 7; index += 1) {
      committedInput.push((await elapsed(() => runtime.dispatch({
        kind: index % 2 === 0 ? "openDetail" : "dismiss",
        ...(index % 2 === 0 ? { detail: "help" } : {}),
      }))).milliseconds);
    }
    await rendering;
    return {
      preparationMs: preparedMs,
      firstShell: shell.milliseconds,
      firstFrameMs,
      focusInputCommitP50: percentile(focusInputCommit, 0.5),
      focusInputCommitP95: percentile(focusInputCommit, 0.95),
      threeRowScrollInputCommitP50: percentile(scrollInputCommit, 0.5),
      threeRowScrollInputCommitP95: percentile(scrollInputCommit, 0.95),
      threeRowScrollToViewportP50: percentile(scrollToViewport, 0.5),
      threeRowScrollToViewportP95: percentile(scrollToViewport, 0.95),
      pageDownInputCommit: pageDown.milliseconds,
      pageUpInputCommit: pageUp.milliseconds,
      scrollBottomInputCommit: scrollBottom.milliseconds,
      scrollTopInputCommit: scrollTop.milliseconds,
      browserViewConstructionP50: percentile(viewConstruction, 0.5),
      browserViewConstructionP95: percentile(viewConstruction, 0.95),
      frameCommitP50: percentile(frameCommit, 0.5),
      frameCommitP95: percentile(frameCommit, 0.95),
      inputStateUpdateWhileRenderingP50: percentile(inputUpdates, 0.5),
      inputStateUpdateWhileRenderingP95: percentile(inputUpdates, 0.95),
      inputToFrameCommitP50: percentile(committedInput, 0.5),
      inputToFrameCommitP95: percentile(committedInput, 0.95),
      frameCommits: runtime.metrics().frameCommits,
      renderingMetrics: await prepared.controller.renderingMetrics(),
      uiStages: uiMetrics.snapshot(),
    };
  } finally {
    await runtime.dispose();
    await prepared.controller.close();
  }
}

async function restoredWorkspaceShell(tabCount) {
  const directory = await mkdtemp(join(tmpdir(), `verge-restoration-${String(tabCount)}-`));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const urls = Array.from({ length: tabCount }, (_, index) =>
    `https://restore-benchmark.test/tab-${String(index)}`
  );
  const activeDocumentIndex = tabCount - 1;
  await store.saveWorkspace({
    documents: urls.map((url) => ({ url, scrollAnchor: { target: null, rowOffset: 0 } })),
    activeDocumentIndex,
    sidePanel: null,
  });
  const starts = [];
  const pending = [];
  let sessions = 0;
  let released = false;
  const prepared = await prepareBrowserTui(urls[0], {
    store,
    restoreWorkspace: true,
    services: {
      async writeTextFile() {}, async downloadFile() { throw new Error("not used"); },
      async openExternal() {}, async openPath() {}, async close() {},
    },
    createSession: () => {
      sessions += 1;
      return new BrowserSession({
        loader: async (requestUrl) => {
          starts.push(requestUrl);
          if (!released) await new Promise((resolvePromise) => pending.push(resolvePromise));
          return fetchResult(requestUrl, "<title>Restored</title><p>restored page</p>");
        },
        stylesheetLoader: async () => { throw new Error("unexpected external stylesheet"); },
        defaultParseMode: "text",
      });
    },
  });
  const host = createMemoryTerminalHost({ terminalSize: { columns: 120, rows: 40 } });
  const runtime = createTuiRuntime({ app: prepared.app, host });
  try {
    const shell = await elapsed(() => runtime.start());
    await waitUntil(() => starts.length === 1, `${String(tabCount)}-tab active restoration start`, 1_000);
    return {
      tabs: tabCount,
      firstShellMs: shell.milliseconds,
      sessionsAtFirstShell: sessions,
      firstStartedUrl: starts[0],
      expectedActiveUrl: urls[activeDocumentIndex],
      placeholdersAtFirstShell: runtime.state().documents.filter((tab) => tab.kind !== "ready").length,
    };
  } finally {
    released = true;
    for (const resolvePromise of pending) resolvePromise();
    await runtime.dispose();
    await prepared.controller.close();
  }
}

const html = authoredLargePage();
const worker = await workerMeasurements(html);
const tui = await tuiMeasurements(html);
const restoration = [await restoredWorkspaceShell(4), await restoredWorkspaceShell(50)];
const metricsMs = {
  warmScrollP95: worker.warmScrollP95,
  noChangeViewportP95: worker.noChangeViewportP95,
  colorDepthOnlyP95: worker.colorDepthOnlyP95,
  browserViewConstructionP95: tui.browserViewConstructionP95,
  inputStateUpdateWhileRenderingP95: tui.inputStateUpdateWhileRenderingP95,
  mainEventLoopDelayP95: worker.mainEventLoopDelayP95,
  firstShell: tui.firstShell,
};
const failures = Object.entries(LIMITS_MS)
  .filter(([name, limit]) => metricsMs[name] > limit)
  .map(([name, limit]) => `${name}=${metricsMs[name].toFixed(2)}ms exceeds ${String(limit)}ms`);
if (worker.maximumRetainedRows > worker.viewportRowBound) failures.push("viewport cell rows exceeded viewport plus overscan");
if (worker.burstFulfilled !== 1) failures.push("100 replaceable viewport requests committed more than the latest generation");
if (worker.releasedWorkerMetrics.attachedDocuments !== 0) failures.push("released worker document remained attached");
for (const result of restoration) {
  if (result.firstShellMs > LIMITS_MS.firstShell) {
    failures.push(`${String(result.tabs)}-tab first shell exceeded ${String(LIMITS_MS.firstShell)}ms`);
  }
  if (result.firstStartedUrl !== result.expectedActiveUrl || result.sessionsAtFirstShell !== 1) {
    failures.push(`${String(result.tabs)}-tab restoration was not active-tab-first`);
  }
}
const report = {
  suite: "incremental-viewport-rendering",
  timestamp: new Date().toISOString(),
  fixture: {
    license: "MIT",
    provenance: "Independently authored deterministic Verge benchmark fixture.",
    sections: 2_000,
    viewport: "120x40",
  },
  worker,
  tui,
  restoration,
  limitsMs: LIMITS_MS,
  ok: failures.length === 0,
  failures,
};
await mkdir(resolve("reports"), { recursive: true });
await writeFile(resolve("reports/incremental-rendering-bench.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ metricsMs, burstFulfilled: worker.burstFulfilled, retainedRows: worker.maximumRetainedRows })}\n`);
if (failures.length > 0) throw new Error(`incremental rendering performance controls failed: ${failures.join(", ")}`);
