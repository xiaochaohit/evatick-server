# 0062 Rename the product to EVA Tick

## Status

Accepted.

## Decision

The product brand is EVA Tick. The server workspace uses the `@evatick/*`
package scope, the runtime app is `evatick-server`, and the provider bridge is
`evatick_server_akshare`.

Existing versioned HTTP payload schemas and problem-type URIs remain stable. A
brand rename does not by itself justify a protocol compatibility break.

## Consequences

Repository paths, deployment examples, package metadata, and user-facing pages
use EVA Tick names. Stable wire identifiers can be renamed only through a
separate versioned migration.
