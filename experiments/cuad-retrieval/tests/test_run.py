from __future__ import annotations

import numpy as np
from pathlib import Path
import subprocess
from typing import Sequence

from retrieval_bench.cases import RetrievalCase
from retrieval_bench.core import Passage
from retrieval_bench.run import (
    RunConfig,
    build_manifest,
    evaluate_case,
    evaluate_case_with_failures,
    git_state,
    sysctl_value,
    validate_case_inventory,
    validate_lanes,
)


class FakeModels:
    def encode_passages(self, passages: Sequence[str]) -> tuple[np.ndarray, float, int]:
        matrix = np.zeros((len(passages), 2), dtype=np.float32)
        matrix[:, 1] = 1
        matrix[6] = [1, 0]
        return matrix, 2.0, 0

    def encode_query(self, query: str) -> tuple[np.ndarray, float, int]:
        return np.asarray([1, 0], dtype=np.float32), 1.0, 0

    def rerank(self, query: str, passages: Sequence[str]) -> tuple[list[float], float, int]:
        return [1.0 if "termination agreement" in passage else 0.0 for passage in passages], 3.0, 0


class TruncatingModels(FakeModels):
    def encode_query(self, query: str) -> tuple[np.ndarray, float, int]:
        vector, duration, _ = super().encode_query(query)
        return vector, duration, 1


def synthetic_case() -> RetrievalCase:
    passages = tuple(
        Passage(index, f"part {index}", "termination agreement" if index == 7 else f"unrelated passage {index}")
        for index in range(1, 11)
    )
    return RetrievalCase("synthetic", "terminate agreement", passages, (frozenset({7}),), "synthetic source")


def test_bm25_case_record_has_strict_top_ten_and_metrics() -> None:
    records = evaluate_case(synthetic_case(), ("bm25",), None)
    assert len(records) == 1
    record = records[0]
    assert [item["passageId"] for item in record["ranked"]][0] == 7
    assert len(record["ranked"]) == 10
    assert record["metrics"]["clauseHitAt"]["5"] == 1.0
    assert record["context"]["clauseHit"] == 1.0
    assert record["context"]["seedPassageIds"] == [7, 1, 2, 3, 4]
    assert 6 in record["context"]["passageIds"]
    assert record["error"] is None


def test_all_lanes_share_one_case_and_produce_complete_records() -> None:
    records = evaluate_case(synthetic_case(), ("bm25", "dense", "hybrid", "rerank"), FakeModels(), repetition=2)
    assert [record["lane"] for record in records] == ["bm25", "dense", "hybrid", "rerank"]
    for record in records:
        assert len(record["ranked"]) == 10
        assert record["metrics"]["clauseHitAt"]["5"] == 1.0
        assert record["truncations"] == 0
        assert record["context"] is not None
        assert record["repetition"] == 2


def test_truncation_emits_a_row_for_every_lane_before_fail_fast() -> None:
    records = evaluate_case_with_failures(
        synthetic_case(),
        ("bm25", "dense", "hybrid", "rerank"),
        TruncatingModels(),
        repetition=1,
    )
    assert [record["lane"] for record in records] == ["bm25", "dense", "hybrid", "rerank"]
    assert records[0]["error"] is None
    for record in records[1:]:
        assert record["error"]["type"] == "InputTruncationError"
        assert record["truncations"] == 1
        assert record["context"] is None
        assert record["ranked"] == []


def test_lane_validation_rejects_unknown_and_duplicate_lanes() -> None:
    for lanes in ((), ("bm25", "bm25"), ("other",), ("dense",)):
        try:
            validate_lanes(lanes)
        except ValueError:
            pass
        else:
            raise AssertionError(f"accepted invalid lanes {lanes}")


def test_inventory_guard_accepts_the_committed_development_shape() -> None:
    cases = []
    for index in range(15):
        clause_count = 0 if index >= 11 else (4 if index == 0 else 2 if index == 1 else 2)
        clauses = tuple(frozenset({position + 1}) for position in range(clause_count))
        passages = tuple(Passage(position, str(position), str(position)) for position in range(1, 11))
        cases.append(RetrievalCase(str(index), "q", passages, clauses, "source"))
    # Adjust to the exact aggregate: 24 clauses but 20 unique passages.
    cases[0] = RetrievalCase("0", "q", cases[0].passages, (frozenset({1}), frozenset({1}), frozenset({2}), frozenset({2})), "source")
    cases[1] = RetrievalCase("1", "q", cases[1].passages, (frozenset({1}), frozenset({1})), "source")
    cases[2] = RetrievalCase("2", "q", cases[2].passages, (frozenset({1}), frozenset({1})), "source")
    validate_case_inventory(cases)


def test_git_receipt_preserves_the_first_paths_leading_dot(monkeypatch) -> None:
    def fake_run(args, **kwargs):
        output = "abc123\n" if args[1] == "rev-parse" else " M .gitignore\n?? experiments/\n"
        return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert git_state(Path("/repo")) == {
        "rev": "abc123",
        "dirty": [".gitignore", "experiments/"],
    }


def test_sysctl_receipt_returns_the_named_hardware_value(monkeypatch) -> None:
    monkeypatch.setattr("retrieval_bench.run.sys.platform", "darwin")

    def fake_run(args, **kwargs):
        assert args == ["sysctl", "-n", "machdep.cpu.brand_string"]
        return subprocess.CompletedProcess(args, 0, stdout="Apple M4 Pro\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert sysctl_value("machdep.cpu.brand_string") == "Apple M4 Pro"


def test_manifest_counts_repetitions_without_inflating_case_inventory() -> None:
    config = RunConfig(
        cases_dir=Path("cases"),
        output_root=Path("runs"),
        device="cpu",
        batch_size=1,
        repetitions=3,
        cache_dir=None,
        lanes=("bm25", "dense", "hybrid", "rerank"),
    )
    manifest = build_manifest(config, [synthetic_case()], "cases", "run", "started")
    assert manifest["cases"] == ["synthetic"]
    assert manifest["expectedRecords"] == 12
    assert manifest["config"]["repetitions"] == 3
    assert manifest["config"]["contextSeedLimit"] == 5
    assert manifest["config"]["contextRadius"] == 1
    assert manifest["config"]["contextWordBudget"] == 3000
