from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = Path.home() / ".codex" / "skills" / "market-cli"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_zip(source: Path, output: Path) -> None:
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(source.parent)
            info = zipfile.ZipInfo.from_file(path, relative.as_posix())
            info.date_time = (2026, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if path.name == "install.sh" else 0o644) << 16
            archive.writestr(info, path.read_bytes())


def main() -> None:
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text())
    version = project["project"]["version"]
    if not (SKILL_ROOT / "SKILL.md").is_file():
        raise SystemExit(f"skill not found: {SKILL_ROOT}")

    subprocess.run([sys.executable, "-m", "build"], cwd=PROJECT_ROOT, check=True)
    wheel = PROJECT_ROOT / "dist" / f"market_cli-{version}-py3-none-any.whl"
    if not wheel.is_file():
        raise SystemExit(f"wheel not found after build: {wheel}")

    output = PROJECT_ROOT / "dist" / f"market-cli-bundle-{version}.zip"
    with tempfile.TemporaryDirectory(prefix="market-cli-bundle-") as temporary:
        bundle = Path(temporary) / f"market-cli-bundle-{version}"
        shutil.copytree(PROJECT_ROOT / "packaging" / "bundle", bundle)
        shutil.copytree(
            SKILL_ROOT,
            bundle / "skills" / "market-cli",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
        )
        packages = bundle / "packages"
        packages.mkdir()
        shutil.copy2(wheel, packages / wheel.name)

        payloads = sorted(
            path for path in bundle.rglob("*") if path.is_file()
        )
        checksums = "".join(
            f"{_sha256(path)}  {path.relative_to(bundle).as_posix()}\n"
            for path in payloads
        )
        (bundle / "SHA256SUMS").write_text(checksums, encoding="utf-8")
        output.unlink(missing_ok=True)
        _write_zip(bundle, output)

    print(output)


if __name__ == "__main__":
    main()
