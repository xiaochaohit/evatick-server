# Market CLI design handoff

## Objective

Implement a model-only CLI that fully exposes AKShare's public data functions. The CLI uses domain-first commands such as `market-cli stock zh-a-hist`, without visible `ak` or `raw` namespaces.

## Current state

- Workspace: `/Users/mac/code/market-cli`
- The original AKShare research clone is not present in this workspace and must be recreated when registry implementation begins.
- Clone is pinned at AKShare `1.18.82`, commit `e977951ef2cb384eccffa35424c75a51bb5fa1c9` dated 2026-08-06.
- The upstream research clone must remain untracked.
- Domain terminology is recorded in `/Users/mac/code/market-cli/CONTEXT.md`.
- Architectural decisions are recorded in `/Users/mac/code/market-cli/docs/adr/0001-*.md` through `0054-*.md`. Read these rather than recreating or summarising their contents.
- No CLI implementation or tests have been created yet.
- The design is complete; no CLI implementation or tests have been created yet.

## Verified source facts

- Approximately 1,094 unique names are exported through the AKShare root namespace.
- After excluding `__version__`, `set_token`, `get_token`, and `pro_api`, the current inclusion set contains 1,090 public data functions.
- A simulated domain/name mapping produced 1,090 unique command paths and no collisions between distinct functions.
- The source contains at least 20 public functions with parameters named like `token`, `cookie`, or `api_key`.
- Static analysis found approximately 1,288 direct `requests` calls, about 1,241 without an explicit `timeout` keyword.
- Importing the pinned AKShare version took about 9 seconds in the current environment.
- The `alternative` domain must cover all source-backed subdomains, including air quality, sunrise/astronomy, movies and artists, migration, rankings, NLP, research datasets, bank regulatory penalties, game rankings, and automotive data. The trading-calendar tool belongs under `stock`.

## Active implementation state

The design interview is complete through ADR 0054. The user approved implementation using test-driven vertical slices and requested a Git commit after every independently verified stage.

## Suggested skills

- `tdd`: use when implementing registry generation, serialization, and command invocation contracts test-first.
- `market-cli`: useful as a reference for market-domain command expectations, but do not let its existing interface override the decisions in this workspace's ADRs.

## Safety and hygiene

- No secrets were supplied in the conversation.
- The user explicitly authorized staged implementation commits.
- Do not duplicate ADR content in new planning documents; link to the existing files.
