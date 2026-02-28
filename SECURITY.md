# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | yes |
| latest `0.x` release line | yes |
| older `0.x` lines | no |

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository.

Include:
- steps to reproduce,
- expected vs observed behavior,
- runtime and version details,
- impact description.

Do not disclose unpatched vulnerabilities in public issues.

## Response targets

- Initial triage response: 3 business days.
- Reproduction and severity classification: 7 business days.
- Fix or mitigation plan for high/critical issues: 14 business days.

## Scope notes

- Network-boundary bypasses and unsafe write-path bugs are in scope.
- Determinism and policy gate bypasses are in scope.
- False positives in non-runtime test fixtures are triaged separately.
