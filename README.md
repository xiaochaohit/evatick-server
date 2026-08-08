# Market CLI

`market-cli` is a model-oriented command-line interface for discoverable market data. Its first data provider is a pinned AKShare release, while published commands are organized by market domain rather than provider namespace.

The implementation is in progress. The accepted terminology lives in [`CONTEXT.md`](./CONTEXT.md), and architectural decisions live in [`docs/adr`](./docs/adr).

## Development

Market CLI requires CPython 3.11 or newer.

```shell
python -m pip install -e .
market-cli --help
python -m pytest
```

Market data is obtained from external sources at runtime. It is provided for research and reference only and does not constitute investment advice. Users are responsible for complying with each data provider and source site's terms.
