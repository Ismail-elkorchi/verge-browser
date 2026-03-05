# Error Model

## `NetworkFetchError`

Represents deterministic network failure classes for fetch workflows.

Common kinds include:
- DNS/network resolution failures,
- timeout failures,
- HTTP error-class outcomes,
- policy-denied URL failures.

## Security-policy rejections

`assertAllowedUrl` and `assertAllowedProtocol` throw on disallowed URLs or protocols.

## Recommended handling

- Treat network and policy failures as expected states.
- Log structured fields and failure classification for observability.
