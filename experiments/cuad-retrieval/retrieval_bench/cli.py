from __future__ import annotations

import argparse
from pathlib import Path

from .run import ALL_LANES, RunConfig, execute, repository_root


def main() -> None:
    root = repository_root()
    parser = argparse.ArgumentParser(description="Run the local CUAD passage-retrieval development benchmark.")
    parser.add_argument(
        "--cases-dir",
        type=Path,
        default=root / "benchmarks/cuad-hard-dev/cases",
    )
    parser.add_argument("--output-root", type=Path, default=root / "runs")
    parser.add_argument("--device", choices=("cpu", "mps"), default="mps")
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--cache-dir")
    parser.add_argument("--lanes", default=",".join(ALL_LANES))
    args = parser.parse_args()
    lanes = tuple(part.strip() for part in args.lanes.split(",") if part.strip())
    if args.batch_size <= 0:
        parser.error("--batch-size must be positive")
    if args.repetitions <= 0:
        parser.error("--repetitions must be positive")
    execute(
        RunConfig(
            cases_dir=args.cases_dir.resolve(),
            output_root=args.output_root.resolve(),
            device=args.device,
            batch_size=args.batch_size,
            repetitions=args.repetitions,
            cache_dir=args.cache_dir,
            lanes=lanes,
        )
    )


if __name__ == "__main__":
    main()
