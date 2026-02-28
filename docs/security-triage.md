# Security Triage Contract

Use this process for pull requests that change browser runtime code, dependency policy, or CI security workflows.

## Alert inventory format

Track each code-scanning alert with this record shape:

`{ruleId,severity,state,file,line,firstSeen,lastSeen,owner}`

## Triage source precedence

1. GitHub Security UI
2. Code Scanning API

If values differ, keep the GitHub Security UI value and document the mismatch in PR evidence.

## Token and permission requirements

- Classic PAT: `security_events` scope is required for code-scanning alert API access.
- Fine-grained token: `Code scanning alerts` repository permission with `read` access.
- Private repositories require repository read access in addition to code-scanning permissions.
- GitHub Actions workflows that upload SARIF must declare `security-events: write`.

## PR evidence requirements

- Include code-scanning review outcome for changed files.
- For every dismissal, include reason and evidence.
- If an alert remains open, link the tracking issue or decision record.

## CodeQL scope exclusions

`verge-browser` excludes these files from CodeQL JavaScript scans:

- `src/app/realworld.ts`
- `scripts/realworld/layout/fetch-wpt-subset.mjs`
- `scripts/oracles/corpus/refresh-wpt-delta-corpus.mjs`

Reason: these paths intentionally bridge network content and filesystem caches for local corpus recording and oracle refresh workflows. They are guarded by dedicated security tests and are not part of terminal rendering execution on normal navigation paths.
