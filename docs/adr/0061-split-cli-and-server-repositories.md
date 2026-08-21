# 0061 Split CLI and server repositories

## Status

Accepted.

## Decision

EVA Tick Server owns the versioned HTTP contract, runtime, storage, provider
plugins, deployment files, and server tests. EVA Tick CLI owns the Python
command-line client, local configuration, output serialization, packaging, and
CLI-facing tests in a separate repository.

The OpenAPI document is published from this repository. Clients consume the
published protocol and must not import server implementation code.

## Consequences

The server can evolve and deploy independently from the CLI. A protocol change
requires an explicit API versioning decision and a corresponding client update.
