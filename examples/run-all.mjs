/**
 * Runs all public examples used by README and release checks.
 * Run: npm run build && node examples/run-all.mjs
 */
import { runCommandHelp } from "./command-help.mjs";
import { runRenderDocument } from "./render-document.mjs";
import { runUrlPolicy } from "./url-policy.mjs";

runCommandHelp();
runUrlPolicy();
runRenderDocument();

console.log("examples:run ok");
