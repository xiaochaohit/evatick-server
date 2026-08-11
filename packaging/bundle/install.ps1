param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\market-cli",
    [string]$BinDir = "$env:LOCALAPPDATA\market-cli\bin",
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" }),
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$BundleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wheel = Get-ChildItem "$BundleDir\packages\market_cli-*-py3-none-any.whl" | Select-Object -First 1
if (-not $Wheel) {
    throw "Market CLI wheel is missing from the bundle."
}

& $Python -c "import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] <= (3, 14) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "CPython 3.11 through 3.14 is required."
}

New-Item -ItemType Directory -Force -Path $InstallRoot, $BinDir, "$CodexHome\skills" | Out-Null
& $Python -m venv "$InstallRoot\venv"
& "$InstallRoot\venv\Scripts\python.exe" -m pip install --upgrade "$($Wheel.FullName)[parquet]"

$Launcher = "@echo off`r`n`"$InstallRoot\venv\Scripts\market-cli.exe`" %*`r`n"
Set-Content -Path "$BinDir\market-cli.cmd" -Value $Launcher -Encoding Ascii

$SkillTarget = "$CodexHome\skills\market-cli"
if (Test-Path $SkillTarget) {
    $Timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $Backup = "$SkillTarget.backup.$Timestamp"
    Move-Item $SkillTarget $Backup
    Write-Host "Existing skill backed up to: $Backup"
}
Copy-Item -Recurse "$BundleDir\skills\market-cli" $SkillTarget

& "$InstallRoot\venv\Scripts\market-cli.exe" doctor
Write-Host "Market CLI installed: $BinDir\market-cli.cmd"
Write-Host "Codex skill installed: $SkillTarget"
