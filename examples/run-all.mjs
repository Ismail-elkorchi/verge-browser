/**
 * What it does: runs all public verge-browser examples in one smoke check.
 * Expected output: prints "examples:run ok" after every example assertion passes.
 * Constraints: examples must be deterministic and safe to execute in a shared process.
 * Run: npm run build && node examples/run-all.mjs
 */
import { runCommandHelp } from "./command-help.mjs";
import { runRenderDocument } from "./render-document.mjs";
import { runUrlPolicy } from "./url-policy.mjs";

runCommandHelp();
runUrlPolicy();
runRenderDocument();

console.log("examples:run ok");
