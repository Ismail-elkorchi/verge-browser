# Deterministic Fuzz Check

This check generates structured malformed/valid HTML cases from a fixed seed and verifies parser/render determinism.

## Commands
- `npm run eval:fuzz:ci`
- `npm run eval:fuzz:release`

## Invariants
- No crashes on generated inputs.
- Same input evaluated twice yields identical case outputs.
- Report includes stable slowest-case triage records (seed + duration).

## Output
- `reports/fuzz.json`

## Policy source
- `evaluation.config.json.fuzz.profiles.ci`
- `evaluation.config.json.fuzz.profiles.release`
