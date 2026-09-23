from __future__ import annotations

import numpy as np
from typing import Sequence

from retrieval_bench.cases import RetrievalCase
from retrieval_bench.core import Passage
from retrieval_bench.report import build_report, ranking_consistency
from retrieval_bench.run import evaluate_case


class FakeModels:
    def encode_passages(self, passages: Sequence[str]) -> tuple[np.ndarray, float, int]:
        matrix = np.zeros((len(passages), 2), dtype=np.float32)
        matrix[:, 1] = 1
        matrix[2] = [1, 0]
        return matrix, 2.0, 0

    def encode_query(self, query: str) -> tuple[np.ndarray, float, int]:
        return np.asarray([1, 0], dtype=np.float32), 1.0, 0

    def rerank(self, query: str, passages: Sequence[str]) -> tuple[list[float], float, int]:
        return [1.0 if "termination" in passage else 0.0 for passage in passages], 3.0, 0


def test_report_is_generated_from_complete_case_records() -> None:
    passages = tuple(
        Passage(index, f"part {index}", "termination" if index == 3 else f"other {index}")
        for index in range(1, 11)
    )
    case = RetrievalCase("synthetic", "termination", passages, (frozenset({3}),), "source")
    lanes = ["bm25", "dense", "hybrid", "rerank"]
    records = evaluate_case(case, lanes, FakeModels())
    manifest = {
        "runId": "synthetic-run",
        "lanes": lanes,
        "modelLoadMs": {"dense_ms": 10, "reranker_ms": 20},
        "peakRssBytes": 1024,
        "git": {"rev": "abc", "dirty": []},
        "casesSha256": "cases",
        "dependencyLockSha256": "lock",
        "resultsSha256": "results",
        "models": {
            "dense": {"id": "dense", "revision": "1"},
            "reranker": {"id": "reranker", "revision": "2"},
        },
        "config": {"device": "cpu", "dtype": "float32", "batchSize": 1, "repetitions": 1},
        "environment": {"python": "3.12", "platform": "test"},
    }
    report = build_report(manifest, [case], records)
    assert "Development evidence only" in report
    assert "BGE-M3 dense" in report
    assert "Paired clause-hit comparison with BM25" in report
    assert "Result hash: `results`" in report


def test_ranking_consistency_does_not_treat_repetitions_as_cases() -> None:
    records = [
        {"caseId": "a", "lane": "bm25", "ranked": [{"passageId": 1}], "repetition": 1},
        {"caseId": "a", "lane": "bm25", "ranked": [{"passageId": 1}], "repetition": 2},
        {"caseId": "b", "lane": "bm25", "ranked": [{"passageId": 1}], "repetition": 1},
        {"caseId": "b", "lane": "bm25", "ranked": [{"passageId": 2}], "repetition": 2},
    ]
    assert ranking_consistency(records, "bm25") == (1, 2)


def test_repeated_report_labels_consistency_as_operational_evidence() -> None:
    passages = tuple(
        Passage(index, f"part {index}", "termination" if index == 3 else f"other {index}")
        for index in range(1, 11)
    )
    case = RetrievalCase("synthetic", "termination", passages, (frozenset({3}),), "source")
    records = evaluate_case(case, ("bm25",), None, repetition=1)
    records += evaluate_case(case, ("bm25",), None, repetition=2)
    manifest = {
        "runId": "repeated-run",
        "lanes": ["bm25"],
        "modelLoadMs": {},
        "peakRssBytes": 1024,
        "git": {"rev": "abc", "dirty": []},
        "casesSha256": "cases",
        "dependencyLockSha256": "lock",
        "resultsSha256": "results",
        "models": {},
        "config": {"device": "cpu", "dtype": "float32", "batchSize": 1, "repetitions": 2},
        "environment": {"python": "3.12", "platform": "test"},
    }
    report = build_report(manifest, [case], records)
    assert "## Ranking consistency" in report
    assert "| BM25 | 1/1 | 100.0% |" in report
    assert "not additional accuracy evidence" in report
