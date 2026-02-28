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
