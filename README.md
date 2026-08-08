# Market CLI

`market-cli` is a model-oriented command-line interface for discoverable market data. Its first data provider is the pinned AKShare 1.18.82 release. It exposes all 1,090 public data functions plus 11 stable stock, index, and calendar entry points, organized by market domain rather than provider namespace.

Command paths are the stable public interface. Provider parameters and result fields track the bound provider version and can evolve between releases.

## Install

```shell
python -m pip install .
market-cli catalog
market-cli search --query zh-a-hist
market-cli stock zh-a-hist --symbol 000001 --limit 5
```

Parquet export is optional:

```shell
python -m pip install '.[parquet]'
market-cli stock zh-a-hist --symbol 000001 --output bars.parquet
```

Use `market-cli DOMAIN COMMAND --help` to inspect provider-aligned named parameters. Add `--output PATH` for JSON, JSONL, CSV, or Parquet file export; `--format` can select the format explicitly.

The accepted terminology lives in [`CONTEXT.md`](./CONTEXT.md), and architectural decisions live in [`docs/adr`](./docs/adr).

## Development

Market CLI requires CPython 3.11 or newer.

```shell
python -m pip install -e '.[test,parquet]'
market-cli --help
python -m pytest
```

Market data is obtained from external sources at runtime. It is provided for research and reference only and does not constitute investment advice. Users are responsible for complying with each data provider and source site's terms.
