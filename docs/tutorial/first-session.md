# Tutorial: First Session

This tutorial validates the default local workflow from build to interactive use.

## 1) Build

```bash
npm install
npm run build
```

## 2) Open the built-in help page

```bash
node dist/cli.js about:help
```

Expected outcome:
- a rendered help page appears in the terminal
- the command prompt is available (`:`)

## 3) Try the core commands

Run these commands inside the interactive prompt:
- `view`
- `links`
- `diag`
- `history`
- `bookmark add tutorial`
- `bookmark list`
- `quit`

## 4) Run scripted examples

```bash
npm run examples:run
```

Expected outcome:
- command exits zero
- terminal prints `examples:run ok`
