from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Iterable, Sequence

from .cases import RetrievalCase


@dataclass(frozen=True)
class QualityMetrics:
    clause_hit_at: dict[int, float]
    passage_recall_at: dict[int, float]
    reciprocal_rank: float
    gold_density_at_5: float


def metrics_for_case(case: RetrievalCase, ranked: Sequence[int]) -> QualityMetrics | None:
    if not case.positive:
        return None
    clause_hit = {
        limit: mean(1.0 if clause & set(ranked[:limit]) else 0.0 for clause in case.clauses)
        for limit in (1, 3, 5, 10)
    }
    gold = case.gold_passages
    passage_recall = {
        limit: len(gold & set(ranked[:limit])) / len(gold)
        for limit in (1, 3, 5, 10)
    }
    first = next((rank for rank, passage_id in enumerate(ranked, start=1) if passage_id in gold), None)
    reciprocal_rank = 0.0 if first is None else 1.0 / first
    gold_density = len(gold & set(ranked[:5])) / 5
    return QualityMetrics(clause_hit, passage_recall, reciprocal_rank, gold_density)


def mean_metrics(rows: Iterable[QualityMetrics]) -> QualityMetrics:
    values = list(rows)
    if not values:
        raise ValueError("cannot aggregate an empty metric set")
    return QualityMetrics(
        clause_hit_at={limit: mean(row.clause_hit_at[limit] for row in values) for limit in (1, 3, 5, 10)},
        passage_recall_at={limit: mean(row.passage_recall_at[limit] for row in values) for limit in (1, 3, 5, 10)},
        reciprocal_rank=mean(row.reciprocal_rank for row in values),
        gold_density_at_5=mean(row.gold_density_at_5 for row in values),
    )


def bootstrap_difference(
    treatment: Sequence[float],
    control: Sequence[float],
    resamples: int = 10_000,
) -> tuple[float, float, float]:
    if len(treatment) != len(control) or not treatment:
        raise ValueError("paired bootstrap needs equal non-empty samples")
    differences = [a - b for a, b in zip(treatment, control, strict=True)]
    seed = 20260830

    def random() -> float:
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed / 4294967296

    means: list[float] = []
    for _ in range(resamples):
        means.append(mean(differences[int(random() * len(differences))] for _ in differences))
    means.sort()
    low = means[int(0.025 * resamples)]
    high = means[int(0.975 * resamples) - 1]
    return mean(differences), low, high
