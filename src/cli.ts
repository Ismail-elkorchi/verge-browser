#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { formatHelpText, parseCommand } from "./app/commands.js";
import { BrowserSession } from "./app/session.js";
import { clearTerminal, formatLinkTable, formatRenderedPage, terminalWidth } from "./app/terminal.js";
import { resolveInputUrl } from "./app/url.js";

function printPage(session: BrowserSession): void {
  const currentPage = session.current;
  if (!currentPage) {
    console.log("No page is loaded.");
    return;
  }

  clearTerminal();
  stdout.write(`${formatRenderedPage(currentPage.rendered)}\n`);
}

async function navigateToTarget(session: BrowserSession, rawTarget: string): Promise<void> {
  const baseUrl = session.current?.finalUrl;
  const resolvedTarget = resolveInputUrl(rawTarget, baseUrl);
  await session.open(resolvedTarget);
  printPage(session);
}

async function main(): Promise<void> {
  const session = new BrowserSession({
    widthProvider: terminalWidth
  });

  const initialTarget = process.argv[2] ?? "https://example.com/";
  const initialUrl = resolveInputUrl(initialTarget);

  await session.open(initialUrl);
  printPage(session);

  const terminalInterface = createInterface({
    input: stdin,
    output: stdout,
    terminal: true
  });

  try {
    for (;;) {
      const rawInput = await terminalInterface.question("verge> ");
      const command = parseCommand(rawInput);

      if (command.kind === "invalid") {
        console.error(`Invalid command: ${command.reason}`);
        continue;
      }

      if (command.kind === "quit") {
        break;
      }

      try {
        switch (command.kind) {
          case "help": {
            console.log(formatHelpText());
            break;
          }
          case "view": {
            printPage(session);
            break;
          }
          case "links": {
            const links = session.current?.rendered.links ?? [];
            console.log(formatLinkTable(links));
            break;
          }
          case "back": {
            await session.back();
            printPage(session);
            break;
          }
          case "forward": {
            await session.forward();
            printPage(session);
            break;
          }
          case "reload": {
            await session.reload();
            printPage(session);
            break;
          }
          case "open-link": {
            await session.openLink(command.index);
            printPage(session);
            break;
          }
          case "go": {
            await navigateToTarget(session, command.target);
            break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Command failed: ${message}`);
      }
    }
  } finally {
    terminalInterface.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
