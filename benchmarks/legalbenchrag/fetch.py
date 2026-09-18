#!/usr/bin/env python3
"""Download the upstream release and run the checksum-verified TypeScript importer.

Usage: npm run data:legalbenchrag [-- --out /path/to/benchmarks]
Requires curl, Python 3, Node.js, and npm ci. No Python packages are needed.
"""

import argparse
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


DATA_URL = (
    "https://www.dropbox.com/scl/fo/r7xfa5i3hdsbxex1w6amw/"
    "AID389Olvtm-ZLTKAPrw6k4?rlkey=5n8zrbk4c08lbit3iiexofmwg&dl=1"
)
ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "benchmarks",
                        help="benchmark output root (default: repository benchmarks/)")
    args = parser.parse_args()
    output = args.out.resolve()
    tsx = ROOT / "node_modules/tsx/dist/cli.mjs"
    if not tsx.is_file():
        parser.error("dependencies are missing; run npm ci first")
    if shutil.which("curl") is None:
        parser.error("curl is required to download the release")
    # Stop before downloading if the importer would overwrite existing data.
    for suite in ("legalbenchrag", "legalbenchrag-dev"):
        for name in ("cases", "documents"):
            target = output / suite / name
            if target.exists() and (not target.is_dir() or any(target.iterdir())):
                parser.error(f"{target} is not empty; data was not changed. "
                             "Use --out with a fresh directory to reconstruct.")

    with tempfile.TemporaryDirectory(prefix="legalbenchrag-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "release.zip"
        print("Downloading LegalBench-RAG (about 87 MB)...", flush=True)
        subprocess.run([
            "curl", "--fail", "--location", "--retry", "3", "--connect-timeout", "30",
            "--max-time", "600", "--output", str(archive), DATA_URL,
        ], check=True)

        extracted = workspace / "data"
        print("Extracting release...", flush=True)
        with zipfile.ZipFile(archive) as release:
            for entry in release.infolist():
                # Dropbox includes a root directory entry named '/'.
                if entry.filename == "/" and entry.is_dir():
                    continue
                path = PurePosixPath(entry.filename)
                if (path.is_absolute() or ".." in path.parts or not path.parts
                        or path.parts[0] not in ("corpus", "benchmarks")
                        or "\\" in entry.filename
                        or stat.S_ISLNK(entry.external_attr >> 16)):
                    raise ValueError(f"Unexpected archive member: {entry.filename}")
            release.extractall(extracted)

        print("Verifying pinned checksums and importing cases...", flush=True)
        subprocess.run([
            "node", str(tsx), str(ROOT / "benchmarks/legalbenchrag/import.ts"),
            "--data", str(extracted), "--out", str(output),
        ], cwd=ROOT, check=True)
    print(f"LegalBench-RAG data is ready in {output}. No benchmark was run.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print(f"LegalBench-RAG fetch failed: {error}", file=sys.stderr)
        sys.exit(1)
