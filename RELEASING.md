# Releasing

Verge Browser publishes to npm and JSR from one GitHub Actions workflow using
trusted publishing. The version in `package.json` and `jsr.json` must match.

1. Update the version and `CHANGELOG.md` in a pull request.
2. Run `npm run release:check` and merge only after hosted checks pass.
3. Create and publish the `vX.Y.Z` GitHub release from the current `main`
   commit.
4. Confirm the Publish workflow qualified and published that exact tag to both
   registries.

The Publish workflow can be dispatched manually for a dry run. A real manual
run is reserved for registry-specific recovery and must check out the exact
version tag; it cannot publish an arbitrary branch or commit.

The same release qualification can be run locally:

```bash
npm run release:check
```

Publishing is never performed from a developer workstation.

## Dependency qualification

Terminal UI may be consumed directly from `Ismail-elkorchi/terminal-ui` at an
exact 40-character Git commit. Branches, tags, abbreviated hashes, other hosts,
and forks are not accepted. The manifest, package lock, and npm installation
record must agree on the source revision; the prepared package must contain
loadable runtime modules. Packed-consumer qualification installs the dependency
from scratch and exercises the CLI worker and TypeScript consumer.

Registry dependencies retain their exact version, public npm URL, and SHA-512
integrity requirements. A Git source pin does not require an npm publication.
