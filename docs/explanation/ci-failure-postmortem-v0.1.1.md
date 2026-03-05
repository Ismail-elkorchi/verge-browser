# CI Failure Postmortem (v0.1.1 Publish)

## Scope
- Workflow: `Publish`
- Trigger: release `v0.1.1`
- Run: https://github.com/Ismail-elkorchi/verge-browser/actions/runs/22651364984
- Failing step: `Run publish gates`

## What failed?
`npm run check:fast` failed during lint, which stopped publish before any registry command executed.

## Why did it fail?
`@typescript-eslint/no-unsafe-*` rules reported unresolved unsafe member access/calls in multiple files, including:
- `src/app/forms.ts` (for example `26:32`, `27:9`, `28:24`)
- `src/app/realworld.ts`
- `src/app/render.ts`
- `src/app/session.ts`
- `src/cli.ts`

Because `check:fast` is a required publish gate, the workflow exited early.

## What change in this PR series removes the failure?
The release/tooling PR in this series fixes the typed-access paths that were treated as unresolved/unsafe and keeps the same lint gate active. That removes the blocking lint class without weakening policy.

## Proof
- Workflow evidence: https://github.com/Ismail-elkorchi/verge-browser/actions/runs/22651364984
- Log extraction command:
  ```bash
  gh run view 22651364984 --log-failed
  ```
