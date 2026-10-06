import type { TerminalCapabilityProfile } from "@ismail-elkorchi/terminal-ui/host";

/** Reports the TUI's session evidence; it never performs independent terminal detection. */
export function terminalPresentationDiagnostics(capabilities: TerminalCapabilityProfile | undefined): readonly string[] {
  if (capabilities === undefined) return [];
  const presentation = capabilities.cellPresentation;
  return [
    `Terminal presentation: ${presentation.support}`,
    "Terminal evidence: capability snapshot before session acquisition",
    ...presentation.facts
      .filter((fact) => (fact.name.startsWith("cellPresentation.") && fact.name !== "cellPresentation.context") || fact.name === "standard:8")
      .slice(0, 16)
      .map((fact) => `Terminal ${fact.name.startsWith("cellPresentation.") ? fact.name.slice("cellPresentation.".length) : fact.name} (${fact.kind}): ${JSON.stringify(fact.value).slice(0, 512)}`),
    ...presentation.diagnostics.slice(0, 8).map((entry) => `Terminal: ${entry.message}`)
  ];
}
