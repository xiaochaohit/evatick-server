#!/bin/sh
set -eu

bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python_command=${MARKET_CLI_PYTHON:-python3}
install_root=${MARKET_CLI_INSTALL_ROOT:-"$HOME/.local/share/market-cli"}
bin_dir=${MARKET_CLI_BIN_DIR:-"$HOME/.local/bin"}
codex_root=${CODEX_HOME:-"$HOME/.codex"}
skills_root=${MARKET_CLI_SKILLS_ROOT:-"$codex_root/skills"}
skill_target="$skills_root/market-cli"
wheel=$(find "$bundle_dir/packages" -maxdepth 1 -name 'market_cli-*-py3-none-any.whl' -print | head -n 1)

if [ -z "$wheel" ]; then
    echo "Market CLI wheel is missing from the bundle." >&2
    exit 1
fi

"$python_command" -c 'import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] <= (3, 14) else 1)' || {
    echo "CPython 3.11 through 3.14 is required." >&2
    exit 1
}

mkdir -p "$install_root" "$bin_dir" "$skills_root"
"$python_command" -m venv "$install_root/venv"
"$install_root/venv/bin/python" -m pip install --upgrade "$wheel[parquet]"
ln -sfn "$install_root/venv/bin/market-cli" "$bin_dir/market-cli"

if [ -e "$skill_target" ]; then
    backup="$skill_target.backup.$(date +%Y%m%d%H%M%S)"
    mv "$skill_target" "$backup"
    echo "Existing skill backed up to: $backup"
fi
cp -R "$bundle_dir/skills/market-cli" "$skill_target"

"$install_root/venv/bin/market-cli" doctor
echo "Market CLI installed: $bin_dir/market-cli"
echo "Codex skill installed: $skill_target"
