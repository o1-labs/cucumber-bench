from __future__ import annotations

import pytest

from retrieval_bench.cases import RetrievalCase
from retrieval_bench.core import Passage
from retrieval_bench.metrics import bootstrap_difference, clause_hit_for_passages, mean_metrics, metrics_for_case


def case(clauses: tuple[frozenset[int], ...]) -> RetrievalCase:
    passages = tuple(Passage(index, str(index), str(index)) for index in range(1, 11))
    return RetrievalCase("case", "query", passages, clauses, "source")


def test_metrics_score_clauses_before_averaging_cases() -> None:
    metrics = metrics_for_case(case((frozenset({2}), frozenset({8, 9}))), [2, 3, 4, 5, 6, 7, 8, 1, 9, 10])
    assert metrics is not None
    assert metrics.clause_hit_at[5] == 0.5
    assert metrics.clause_hit_at[10] == 1.0
    assert metrics.passage_recall_at[5] == pytest.approx(1 / 3)
    assert metrics.reciprocal_rank == 1.0
    assert metrics.gold_density_at_5 == 0.2


def test_absence_case_is_not_scored_as_retrieval_quality() -> None:
    assert metrics_for_case(case(()), list(range(1, 11))) is None
    assert clause_hit_for_passages(case(()), list(range(1, 11))) is None


def test_clause_hit_scores_all_selected_passages_without_a_rank_cutoff() -> None:
    value = clause_hit_for_passages(case((frozenset({2}), frozenset({8, 9}))), [2, 8])
    assert value == 1.0


def test_mean_metrics_averages_case_metrics() -> None:
    first = metrics_for_case(case((frozenset({1}),)), list(range(1, 11)))
    second = metrics_for_case(case((frozenset({10}),)), list(range(1, 11)))
    assert first is not None and second is not None
    aggregate = mean_metrics([first, second])
    assert aggregate.clause_hit_at[5] == 0.5
    assert aggregate.clause_hit_at[10] == 1.0


def test_paired_bootstrap_is_deterministic() -> None:
    first = bootstrap_difference([1, 1, 0, 1], [0, 1, 0, 0], resamples=1000)
    second = bootstrap_difference([1, 1, 0, 1], [0, 1, 0, 0], resamples=1000)
    assert first == second
    assert first[0] == 0.5
