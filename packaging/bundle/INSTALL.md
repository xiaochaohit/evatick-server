# Market CLI bundle installation

This bundle installs Market CLI 0.1.0 and the matching Codex `market-cli` skill.

## Requirements

- CPython 3.11–3.14, 64-bit
- Internet access during installation for AKShare and other Python dependencies
- Codex, if you want to use the bundled skill

## macOS or Linux

Extract the ZIP, open a terminal in the extracted directory, and run:

```shell
sh install.sh
```

The installer creates an isolated environment under `~/.local/share/market-cli`, links the command at `~/.local/bin/market-cli`, and installs the skill under `${CODEX_HOME:-~/.codex}/skills/market-cli`.

Ensure `~/.local/bin` is in `PATH`, then verify:

```shell
market-cli doctor
market-cli --help
```

## Windows PowerShell

Extract the ZIP, open PowerShell in the extracted directory, and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

The installer creates an isolated environment under `%LOCALAPPDATA%\market-cli`, creates `%LOCALAPPDATA%\market-cli\bin\market-cli.cmd`, and installs the skill under `%CODEX_HOME%\skills\market-cli` or `%USERPROFILE%\.codex\skills\market-cli`.

Add `%LOCALAPPDATA%\market-cli\bin` to `PATH`, then run `market-cli doctor`.

## Existing skill

If a `market-cli` skill already exists, the installer renames it to a timestamped sibling directory before installing this copy. It does not delete the backup.

## Custom locations

macOS/Linux environment variables:

- `MARKET_CLI_INSTALL_ROOT`: isolated CLI location
- `MARKET_CLI_BIN_DIR`: command-link directory
- `MARKET_CLI_SKILLS_ROOT`: skill installation directory
- `CODEX_HOME`: Codex configuration root
- `MARKET_CLI_PYTHON`: Python executable

Windows installer parameters:

```powershell
.\install.ps1 -InstallRoot D:\Apps\market-cli -BinDir D:\Apps\bin -CodexHome D:\Codex
```

## Integrity

`SHA256SUMS` contains a checksum for every bundled payload file. Verify it before installation when the ZIP was transferred through an untrusted channel.
