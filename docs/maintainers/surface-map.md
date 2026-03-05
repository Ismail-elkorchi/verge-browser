# Surface Map

This note records the current module-of-truth paths for published consumer surfaces.

- JSR root module: `jsr/mod.ts` (from `jsr.json` `exports["."]`)
- Node/TypeScript consumer root: `dist/mod.d.ts` (from `package.json` `types`)
- Node runtime import target: `dist/mod.js` (from `package.json` `exports["."].import`)

Node and JSR are versioned together but may expose different subsets. See `docs/reference/api-overview.md` for the current parity notes.
