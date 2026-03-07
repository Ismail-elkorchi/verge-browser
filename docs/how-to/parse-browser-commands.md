# Parse Browser Commands

Goal: parse CLI/browser command text into structured command objects.

```ts
import { formatHelpText, parseCommand } from "@ismail-elkorchi/verge-browser";

const parsed = parseCommand("bookmark add docs");
console.log(parsed.kind);
console.log(parseCommand("bookmark open nope").kind);
console.log(formatHelpText().includes("save text <path>"));
```

Expected output:
- Deterministic command kind.
- Invalid input is reported as `kind === "invalid"` instead of throwing.
- Help text includes expected verbs.
