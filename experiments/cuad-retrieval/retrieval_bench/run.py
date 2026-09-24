from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import time
from typing import Any, Protocol, Sequence

import numpy as np

from .cases import RetrievalCase, load_cases
from .chart import build_chart
from .context import CONTEXT_RADIUS, CONTEXT_SEED_LIMIT, CONTEXT_WORD_BUDGET, select_adjacent_context
from .core import Bm25Retriever, RankedPassage, RetrievalRequest, passage_ids, rank_dense, reciprocal_rank_fusion, rerank
from .metrics import QualityMetrics, clause_hit_for_passages, metrics_for_case
from .models import BGE_MODEL, BGE_REVISION, MAX_LENGTH, RERANKER_MODEL, RERANKER_REVISION, LocalModels
from .report import build_report
from .timing import elapsed_ms


ALL_LANES = ("bm25", "dense", "hybrid", "rerank")
OUTPUT_LIMIT = 10
REVIEW_LIMIT = 5
CANDIDATE_LIMIT = 15
FUSION_LIMIT = CANDIDATE_LIMIT * 2
RRF_CONSTANT = 60


@dataclass(frozen=True)
class RunConfig:
    cases_dir: Path
    output_root: Path
    device: str
    batch_size: int
    repetitions: int
    cache_dir: str | None
    lanes: tuple[str, ...]


class ModelBackend(Protocol):
    def encode_passages(self, passages: Sequence[str]) -> tuple[np.ndarray, float, int]: ...

    def encode_query(self, query: str) -> tuple[np.ndarray, float, int]: ...

    def rerank(self, query: str, passages: Sequence[str]) -> tuple[list[float], float, int]: ...


class InputTruncationError(ValueError):
    def __init__(self, message: str, truncations: dict[str, int]):
        super().__init__(message)
        self.truncations = truncations


def execute(config: RunConfig) -> Path:
    validate_lanes(config.lanes)
    cases, cases_hash = load_cases(config.cases_dir)
    validate_case_inventory(cases)
    run_id = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    output_dir = config.output_root / f"retrieval-{run_id}"
    output_dir.mkdir(parents=True, exist_ok=False)
    started_at = datetime.now(timezone.utc).isoformat()
    records: list[dict[str, Any]] = []
    models: LocalModels | None = None
    model_load_ms: dict[str, float] = {}

    manifest = build_manifest(config, cases, cases_hash, run_id, started_at)
    write_json(output_dir / "run.json", manifest)
    try:
        if any(lane != "bm25" for lane in config.lanes):
            models = LocalModels(
                config.device,
                config.batch_size,
                config.cache_dir,
                load_reranker="rerank" in config.lanes,
            )
            model_load_ms = asdict(models.load_timing)
        for repetition in range(1, config.repetitions + 1):
            for index, case in enumerate(cases, start=1):
                print(
                    f"[repetition {repetition}/{config.repetitions}] [{index}/{len(cases)}] {case.id}",
                    flush=True,
                )
                case_records = evaluate_case_with_failures(case, config.lanes, models, repetition)
                records.extend(case_records)
                with (output_dir / "results.jsonl").open("a", encoding="utf-8") as handle:
                    for record in case_records:
                        handle.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
                failed = next((record for record in case_records if record["error"] is not None), None)
                if failed is not None:
                    raise RuntimeError(
                        f"{case.id}: {failed['error']['type']}: {failed['error']['message']}"
                    )

        manifest.update(
            {
                "finishedAt": datetime.now(timezone.utc).isoformat(),
                "complete": len(records) == len(cases) * len(config.lanes) * config.repetitions,
                "records": len(records),
                "modelLoadMs": model_load_ms,
                "peakRssBytes": peak_rss_bytes(),
                "resultsSha256": sha256_file(output_dir / "results.jsonl"),
            }
        )
        write_json(output_dir / "run.json", manifest)
        report = build_report(manifest, cases, records)
        (output_dir / "report.md").write_text(report, encoding="utf-8")
        chart = build_chart(manifest, records)
        (output_dir / "chart.html").write_text(chart, encoding="utf-8")
        print(f"written to {output_dir}", flush=True)
        return output_dir
    except Exception as error:
        results_path = output_dir / "results.jsonl"
        manifest.update(
            {
                "finishedAt": datetime.now(timezone.utc).isoformat(),
                "complete": False,
                "records": len(records),
                "modelLoadMs": model_load_ms,
                "peakRssBytes": peak_rss_bytes(),
                "resultsSha256": sha256_file(results_path) if results_path.exists() else None,
                "error": {"type": type(error).__name__, "message": str(error)},
            }
        )
        write_json(output_dir / "run.json", manifest)
        raise


def evaluate_case(
    case: RetrievalCase,
    lanes: Sequence[str],
    models: ModelBackend | None,
    repetition: int = 1,
) -> list[dict[str, Any]]:
    if repetition <= 0:
        raise ValueError("repetition must be positive")
    passages = case.passages
    request_for = lambda limit: RetrievalRequest(case.query, passages, limit)

    started = time.perf_counter()
    bm25 = Bm25Retriever(passages)
    bm25_index_ms = elapsed_ms(started)
    started = time.perf_counter()
    bm25_candidates = bm25.retrieve(request_for(CANDIDATE_LIMIT))
    bm25_query_ms = elapsed_ms(started)

    dense_candidates: list[RankedPassage] = []
    dense_index_ms = dense_query_ms = 0.0
    dense_truncations = 0
    if any(lane != "bm25" for lane in lanes):
        if models is None:
            raise ValueError("semantic lanes need local models")
        passage_matrix, dense_index_ms, passage_truncations = models.encode_passages([p.text for p in passages])
        query_vector, query_encode_ms, query_truncations = models.encode_query(case.query)
        dense_truncations = passage_truncations + query_truncations
        if dense_truncations:
            raise InputTruncationError(
                f"BGE-M3 truncated {dense_truncations} inputs",
                {
                    "bm25": 0,
                    "dense": dense_truncations,
                    "hybrid": dense_truncations,
                    "rerank": dense_truncations,
                },
            )
        started = time.perf_counter()
        dense_candidates = rank_dense([p.id for p in passages], query_vector, passage_matrix, CANDIDATE_LIMIT)
        dense_query_ms = query_encode_ms + elapsed_ms(started)

    started = time.perf_counter()
    hybrid_candidates = (
        reciprocal_rank_fusion(bm25_candidates, dense_candidates, FUSION_LIMIT, RRF_CONSTANT)
        if dense_candidates
        else []
    )
    hybrid_fusion_ms = elapsed_ms(started) if dense_candidates else 0.0

    reranked: list[RankedPassage] = []
    rerank_ms = 0.0
    rerank_truncations = 0
    if "rerank" in lanes:
        assert models is not None
        passage_by_id = {passage.id: passage for passage in passages}
        scores, rerank_ms, rerank_truncations = models.rerank(
            case.query,
            [passage_by_id[item.passage_id].text for item in hybrid_candidates],
        )
        if rerank_truncations:
            raise InputTruncationError(
                f"reranker truncated {rerank_truncations} pairs",
                {"bm25": 0, "dense": 0, "hybrid": 0, "rerank": rerank_truncations},
            )
        reranked = rerank(hybrid_candidates, scores, OUTPUT_LIMIT)

    rankings = {
        "bm25": bm25_candidates[:OUTPUT_LIMIT],
        "dense": dense_candidates[:OUTPUT_LIMIT],
        "hybrid": hybrid_candidates[:OUTPUT_LIMIT],
        "rerank": reranked,
    }
    timings = {
        "bm25": {"indexMs": bm25_index_ms, "queryMs": bm25_query_ms},
        "dense": {"indexMs": dense_index_ms, "queryMs": dense_query_ms},
        "hybrid": {
            "indexMs": bm25_index_ms + dense_index_ms,
            "queryMs": bm25_query_ms + dense_query_ms + hybrid_fusion_ms,
        },
        "rerank": {
            "indexMs": bm25_index_ms + dense_index_ms,
            "queryMs": bm25_query_ms + dense_query_ms + hybrid_fusion_ms + rerank_ms,
        },
    }
    candidate_pools = {
        "bm25": bm25_candidates,
        "dense": dense_candidates,
        "hybrid": hybrid_candidates,
        "rerank": hybrid_candidates,
    }
    truncations = {
        "bm25": 0,
        "dense": dense_truncations,
        "hybrid": dense_truncations,
        "rerank": dense_truncations + rerank_truncations,
    }
    records = []
    for lane in lanes:
        ranked = rankings[lane]
        validate_ranking(case, ranked)
        quality = metrics_for_case(case, passage_ids(ranked))
        context = select_adjacent_context(passages, passage_ids(ranked))
        candidate_ids = set(passage_ids(candidate_pools[lane]))
        candidate_clause_hit = (
            sum(1.0 if clause & candidate_ids else 0.0 for clause in case.clauses) / len(case.clauses)
            if case.positive
            else None
        )
        records.append(
            {
                "caseId": case.id,
                "lane": lane,
                "repetition": repetition,
                "positive": case.positive,
                "ranked": [ranked_json(item, rank) for rank, item in enumerate(ranked, start=1)],
                "candidatePoolPassageIds": passage_ids(candidate_pools[lane]),
                "candidatePoolClauseHit": candidate_clause_hit,
                "metrics": quality_json(quality),
                "context": {
                    "seedPassageIds": list(context.seed_passage_ids),
                    "passageIds": list(context.passage_ids),
                    "seedWordCount": context.seed_word_count,
                    "wordCount": context.word_count,
                    "clauseHit": clause_hit_for_passages(case, context.passage_ids),
                },
                "timings": timings[lane],
                "truncations": truncations[lane],
                "error": None,
            }
        )
    return records


def evaluate_case_with_failures(
    case: RetrievalCase,
    lanes: Sequence[str],
    models: ModelBackend | None,
    repetition: int,
) -> list[dict[str, Any]]:
    try:
        return evaluate_case(case, lanes, models, repetition)
    except InputTruncationError as error:
        unaffected = tuple(lane for lane in lanes if error.truncations.get(lane, 0) == 0)
        successful = evaluate_case(case, unaffected, models, repetition) if unaffected else []
        failed = failure_records(
            case,
            tuple(lane for lane in lanes if lane not in unaffected),
            repetition,
            error,
        )
        by_lane = {record["lane"]: record for record in [*successful, *failed]}
        return [by_lane[lane] for lane in lanes]
    except Exception as error:
        return failure_records(case, lanes, repetition, error)


def failure_records(
    case: RetrievalCase,
    lanes: Sequence[str],
    repetition: int,
    error: Exception,
) -> list[dict[str, Any]]:
    truncations = error.truncations if isinstance(error, InputTruncationError) else {}
    error_json = {"type": type(error).__name__, "message": str(error)}
    return [
        {
            "caseId": case.id,
            "lane": lane,
            "repetition": repetition,
            "positive": case.positive,
            "ranked": [],
            "candidatePoolPassageIds": [],
            "candidatePoolClauseHit": None,
            "metrics": None,
            "context": None,
            "timings": {"indexMs": 0.0, "queryMs": 0.0},
            "truncations": truncations.get(lane, 0),
            "error": error_json,
        }
        for lane in lanes
    ]


def ranked_json(item: RankedPassage, rank: int) -> dict[str, int | float | None]:
    return {
        "passageId": item.passage_id,
        "rank": rank,
        "score": item.score,
        "bm25Rank": item.bm25_rank,
        "denseRank": item.dense_rank,
    }


def quality_json(metrics: QualityMetrics | None) -> dict[str, Any] | None:
    if metrics is None:
        return None
    return {
        "clauseHitAt": {str(key): value for key, value in metrics.clause_hit_at.items()},
        "passageRecallAt": {str(key): value for key, value in metrics.passage_recall_at.items()},
        "reciprocalRank": metrics.reciprocal_rank,
        "goldDensityAt5": metrics.gold_density_at_5,
    }


def validate_ranking(case: RetrievalCase, ranked: Sequence[RankedPassage]) -> None:
    ids = passage_ids(ranked)
    if len(ids) != OUTPUT_LIMIT or len(set(ids)) != OUTPUT_LIMIT:
        raise ValueError(f"{case.id}: ranking must contain {OUTPUT_LIMIT} unique passages")
    if any(passage_id < 1 or passage_id > len(case.passages) for passage_id in ids):
        raise ValueError(f"{case.id}: ranking has an out-of-range passage")
    if any(not np.isfinite(item.score) for item in ranked):
        raise ValueError(f"{case.id}: ranking has a non-finite score")


def validate_lanes(lanes: Sequence[str]) -> None:
    if not lanes or len(set(lanes)) != len(lanes):
        raise ValueError("lanes must be unique and non-empty")
    unknown = set(lanes) - set(ALL_LANES)
    if unknown:
        raise ValueError(f"unknown lanes: {', '.join(sorted(unknown))}")
    if "bm25" not in lanes:
        raise ValueError("BM25 is required as the paired control lane")


def validate_case_inventory(cases: Sequence[RetrievalCase]) -> None:
    positives = sum(case.positive for case in cases)
    clauses = sum(len(case.clauses) for case in cases)
    unique_gold = sum(len(case.gold_passages) for case in cases)
    if (len(cases), positives, clauses, unique_gold) != (15, 11, 24, 20):
        raise ValueError(
            "unexpected cuad-hard-dev inventory: "
            f"cases={len(cases)}, positives={positives}, clauses={clauses}, uniqueGold={unique_gold}"
        )


def build_manifest(
    config: RunConfig,
    cases: Sequence[RetrievalCase],
    cases_hash: str,
    run_id: str,
    started_at: str,
) -> dict[str, Any]:
    root = repository_root()
    lock_path = root / "experiments/cuad-retrieval/uv.lock"
    models: dict[str, dict[str, str]] = {}
    if any(lane != "bm25" for lane in config.lanes):
        models["dense"] = {"id": BGE_MODEL, "revision": BGE_REVISION, "license": "MIT"}
    if "rerank" in config.lanes:
        models["reranker"] = {
            "id": RERANKER_MODEL,
            "revision": RERANKER_REVISION,
            "license": "Apache-2.0",
        }
    return {
        "schema": "cuad-retrieval-run-v1",
        "runId": run_id,
        "status": "development-only",
        "startedAt": started_at,
        "finishedAt": None,
        "complete": False,
        "expectedRecords": len(cases) * len(config.lanes) * config.repetitions,
        "records": 0,
        "command": sys.argv,
        "suite": "cuad-hard-dev",
        "cases": [case.id for case in cases],
        "casesSha256": cases_hash,
        "lanes": list(config.lanes),
        "config": {
            "outputLimit": OUTPUT_LIMIT,
            "reviewLimit": REVIEW_LIMIT,
            "candidateLimit": CANDIDATE_LIMIT,
            "fusionLimit": FUSION_LIMIT,
            "rrfConstant": RRF_CONSTANT,
            "contextSeedLimit": CONTEXT_SEED_LIMIT,
            "contextRadius": CONTEXT_RADIUS,
            "contextWordBudget": CONTEXT_WORD_BUDGET,
            "batchSize": config.batch_size,
            "repetitions": config.repetitions,
            "maxLength": MAX_LENGTH,
            "device": config.device,
            "dtype": "float32",
        },
        "models": models,
        "environment": environment_receipt(),
        "dependencyLockSha256": sha256_file(lock_path) if lock_path.exists() else None,
        "git": git_state(root),
    }


def environment_receipt() -> dict[str, Any]:
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "hardwareModel": sysctl_value("hw.model"),
        "chip": sysctl_value("machdep.cpu.brand_string"),
        "logicalCpus": os.cpu_count(),
        "memoryBytes": physical_memory_bytes(),
    }


def physical_memory_bytes() -> int | None:
    if sys.platform == "darwin":
        value = sysctl_value("hw.memsize")
        return int(value) if value is not None else None
    page_size = os.sysconf("SC_PAGE_SIZE") if "SC_PAGE_SIZE" in os.sysconf_names else None
    page_count = os.sysconf("SC_PHYS_PAGES") if "SC_PHYS_PAGES" in os.sysconf_names else None
    return None if page_size is None or page_count is None else int(page_size * page_count)


def sysctl_value(name: str) -> str | None:
    if sys.platform != "darwin":
        return None
    result = subprocess.run(["sysctl", "-n", name], check=False, capture_output=True, text=True)
    value = result.stdout.strip()
    return value if result.returncode == 0 and value else None


def peak_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def git_state(root: Path) -> dict[str, Any]:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.rstrip("\n")

    dirty = [line[3:] for line in git("status", "--porcelain").splitlines()]
    return {"rev": git("rev-parse", "HEAD"), "dirty": dirty}


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
