from __future__ import annotations

import json
import platform
from pathlib import Path
from typing import Any, Callable, TypeVar
from urllib.parse import quote, urlencode

import click

from market_cli import __version__
from market_cli.http_client import InvocationError, MarketHttpClient
from market_cli.output import export_result
from market_cli.serialization import SerializationError, dumps

F = TypeVar("F", bound=Callable[..., Any])


class MarketRoot(click.Group):
    """Render compact deterministic root help for people and models."""

    def format_help(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        formatter.write("NAME\n    market-cli\n\n")
        formatter.write("PURPOSE\n    通过 Market Server 查询第一版股票和指数数据。\n\n")
        formatter.write("USAGE\n    market-cli [--server-url URL] COMMAND [OPTIONS]\n\n")
        formatter.write("OPTIONS\n    --server-url URL\n\n")
        formatter.write("COMMANDS\n")
        for name in self.list_commands(ctx):
            formatter.write(f"    {name}\n")


def data_options(function: F) -> F:
    decorators = [
        click.option("--limit", type=click.IntRange(min=1)),
        click.option("--output", type=click.Path(path_type=Path)),
        click.option("--format", "output_format", type=click.Choice(["json", "jsonl", "csv", "parquet"])),
        click.option("--overwrite", is_flag=True, default=False),
        click.option("--timeout", type=click.FloatRange(min=0.1), default=120.0, show_default=True),
        click.option("--retries", type=click.IntRange(min=0), default=2, show_default=True),
    ]
    for decorator in reversed(decorators):
        function = decorator(function)
    return function


def _client(timeout: float, retries: int) -> MarketHttpClient:
    server_url = click.get_current_context().find_root().params["server_url"]
    return MarketHttpClient(server_url, timeout, retries)


def _emit(
    value: Any,
    *,
    limit: int | None,
    output: Path | None,
    output_format: str | None,
    overwrite: bool,
) -> None:
    if output is None:
        if output_format is not None:
            raise click.UsageError("--format requires --output")
        click.echo(dumps(value, limit=limit))
        return
    click.echo(dumps(export_result(
        value,
        output=output,
        output_format=output_format,
        overwrite=overwrite,
        limit=limit,
    )))


def _query(values: dict[str, Any]) -> str:
    return urlencode({key: value for key, value in values.items() if value is not None})


def _resolve(
    client: MarketHttpClient,
    symbol: str,
    instrument_type: str,
    capability: str,
) -> str:
    return client.resolve(symbol, instrument_type, capability)


@click.group(cls=MarketRoot)
@click.option(
    "--server-url",
    envvar="MARKET_CLI_SERVER_URL",
    default="http://127.0.0.1:8765",
    show_default=True,
)
def cli(server_url: str) -> None:
    """Market Server client."""


@cli.command("health")
@click.option("--timeout", type=click.FloatRange(min=0.1), default=10.0)
@click.option("--retries", type=click.IntRange(min=0), default=0)
def health_command(timeout: float, retries: int) -> None:
    response = _client(timeout, retries).request("GET", "/v1/health")
    click.echo(dumps(response.get("data", {})))


@cli.command("version")
def version_command() -> None:
    click.echo(dumps({
        "market_cli": __version__,
        "market_server_api": "v1",
        "python": platform.python_version(),
    }))


@cli.group("instrument")
def instrument_group() -> None:
    """Discover and resolve canonical instruments."""


@instrument_group.command("list")
@click.option("--type", "instrument_type", type=click.Choice(["equity", "index"]))
@click.option("--venue")
@click.option("--publisher")
@click.option("--capability", type=click.Choice(["quote", "bars", "constituents"]))
@click.option("--cursor")
@data_options
def instrument_list_command(
    instrument_type: str | None,
    venue: str | None,
    publisher: str | None,
    capability: str | None,
    cursor: str | None,
    **options: Any,
) -> None:
    limit = options["limit"] or 100
    response = _client(options["timeout"], options["retries"]).request(
        "GET",
        f"/v1/instruments?{_query({
            'instrument_type': instrument_type,
            'venue': venue,
            'publisher': publisher,
            'capability': capability,
            'cursor': cursor,
            'limit': min(limit, 1000),
        })}",
    )
    _emit(
        {"items": response.get("data", []), "next_cursor": response.get("page", {}).get("next_cursor")},
        limit=None,
        output=options["output"],
        output_format=options["output_format"],
        overwrite=options["overwrite"],
    )


@instrument_group.command("search")
@click.option("--query", required=True)
@click.option("--type", "instrument_type", type=click.Choice(["equity", "index"]))
@click.option("--venue")
@click.option("--publisher")
@click.option("--capability", type=click.Choice(["quote", "bars", "constituents"]))
@data_options
def instrument_search_command(
    query: str,
    instrument_type: str | None,
    venue: str | None,
    publisher: str | None,
    capability: str | None,
    **options: Any,
) -> None:
    limit = min(options["limit"] or 20, 200)
    response = _client(options["timeout"], options["retries"]).request(
        "GET",
        f"/v1/instrument-search?{_query({
            'q': query,
            'instrument_type': instrument_type,
            'venue': venue,
            'publisher': publisher,
            'capability': capability,
            'limit': limit,
        })}",
    )
    _emit(
        response.get("data", []),
        limit=limit,
        output=options["output"],
        output_format=options["output_format"],
        overwrite=options["overwrite"],
    )


@instrument_group.command("resolve")
@click.option("--query", required=True)
@click.option("--type", "instrument_type", type=click.Choice(["equity", "index"]))
@click.option("--venue")
@click.option("--publisher")
@click.option("--capability", type=click.Choice(["quote", "bars", "constituents"]))
@click.option("--timeout", type=click.FloatRange(min=0.1), default=120.0)
@click.option("--retries", type=click.IntRange(min=0), default=2)
def instrument_resolve_command(
    query: str,
    instrument_type: str | None,
    venue: str | None,
    publisher: str | None,
    capability: str | None,
    timeout: float,
    retries: int,
) -> None:
    context = {
        "instrument_type": instrument_type,
        "venue": venue,
        "publisher": publisher,
        "capability": capability,
    }
    response = _client(timeout, retries).request(
        "POST",
        "/v1/instrument-resolve",
        {"query": query, "context": {key: value for key, value in context.items() if value is not None}},
    )
    click.echo(dumps(response.get("data", {})))


@instrument_group.command("show")
@click.option("--id", "instrument_id", required=True)
@click.option("--timeout", type=click.FloatRange(min=0.1), default=120.0)
@click.option("--retries", type=click.IntRange(min=0), default=2)
def instrument_show_command(instrument_id: str, timeout: float, retries: int) -> None:
    response = _client(timeout, retries).request(
        "GET", f"/v1/instruments/{quote(instrument_id, safe='')}"
    )
    click.echo(dumps(response.get("data", {})))


def quote_command(instrument_type: str) -> Callable[..., None]:
    @click.command("quotes")
    @click.option("--symbol", required=True)
    @click.option("--timeout", type=click.FloatRange(min=0.1), default=120.0)
    @click.option("--retries", type=click.IntRange(min=0), default=2)
    def command(symbol: str, timeout: float, retries: int) -> None:
        client = _client(timeout, retries)
        instrument_id = _resolve(client, symbol, instrument_type, "quote")
        response = client.request(
            "GET", f"/v1/instruments/{quote(instrument_id, safe='')}/quote"
        )
        click.echo(dumps(response.get("data", {})))
    return command


def bars_command(instrument_type: str) -> Callable[..., None]:
    @click.command("bars")
    @click.option("--symbol", required=True)
    @click.option("--interval", type=click.Choice(["1m", "5m", "15m", "30m", "60m", "1d", "1w", "1mo"]), default="1d")
    @click.option("--start")
    @click.option("--end")
    @click.option("--adjustment", type=click.Choice(["none", "forward", "backward"]), default="none")
    @data_options
    def command(
        symbol: str,
        interval: str,
        start: str | None,
        end: str | None,
        adjustment: str,
        **options: Any,
    ) -> None:
        client = _client(options["timeout"], options["retries"])
        instrument_id = _resolve(client, symbol, instrument_type, "bars")
        response = client.request(
            "GET",
            f"/v1/instruments/{quote(instrument_id, safe='')}/bars?{_query({
                'interval': interval,
                'start': start,
                'end': end,
                'adjustment': adjustment,
            })}",
        )
        _emit(
            response.get("data", []),
            limit=options["limit"],
            output=options["output"],
            output_format=options["output_format"],
            overwrite=options["overwrite"],
        )
    return command


@cli.group("stock")
def stock_group() -> None:
    """Query mainland A-share data."""


stock_group.add_command(quote_command("equity"))
stock_group.add_command(bars_command("equity"))


@cli.group("index")
def index_group() -> None:
    """Query SSE, SZSE, and CSI index data."""


index_group.add_command(quote_command("index"))
index_group.add_command(bars_command("index"))


@index_group.command("constituents")
@click.option("--symbol", required=True)
@click.option("--as-of")
@data_options
def index_constituents_command(symbol: str, as_of: str | None, **options: Any) -> None:
    client = _client(options["timeout"], options["retries"])
    instrument_id = _resolve(client, symbol, "index", "constituents")
    suffix = f"?{_query({'as_of': as_of})}" if as_of else ""
    response = client.request(
        "GET", f"/v1/indices/{quote(instrument_id, safe='')}/constituents{suffix}"
    )
    _emit(
        response.get("data", []),
        limit=options["limit"],
        output=options["output"],
        output_format=options["output_format"],
        overwrite=options["overwrite"],
    )


def main() -> None:
    try:
        cli.main(prog_name="market-cli", standalone_mode=False)
    except click.UsageError as error:
        _fail("INVALID_ARGUMENT", error.format_message(), False, 2)
    except SerializationError as error:
        _fail(error.code, error.message, False, 1)
    except InvocationError as error:
        _fail(error.code, error.message, error.retryable, 1)


def _fail(code: str, message: str, retryable: bool, exit_code: int) -> None:
    click.echo(json.dumps(
        {"code": code, "message": message, "retryable": retryable},
        ensure_ascii=False,
        separators=(",", ":"),
    ), err=True)
    raise SystemExit(exit_code)
