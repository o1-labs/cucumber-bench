from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any, Sequence

from .cases import RetrievalCase
from .metrics import bootstrap_difference


LANE_LABELS = {
    "bm25": "BM25",
    "dense": "BGE-M3 dense",
    "hybrid": "BM25 + dense RRF",
    "rerank": "Hybrid + BGE reranker",
}


@dataclass(frozen=True)
class AdjacentContextSummary:
    seed_clause_hit: float
    expanded_clause_hit: float
    mean_seed_words: float
    mean_expanded_words: float
    mean_expanded_passages: float

    @property
    def word_multiplier(self) -> float:
        return self.mean_expanded_words / self.mean_seed_words


def build_report(
    manifest: dict[str, Any],
    cases: Sequence[RetrievalCase],
    records: Sequence[dict[str, Any]],
) -> str:
    positives = [case for case in cases if case.positive]
    negatives = [case for case in cases if not case.positive]
    lines = [
        "# CUAD retrieval development result",
        "",
        "> Development evidence only. This is not a locked-test result and must not be presented as one.",
        "",
        f"Run: `{manifest['runId']}`",
        "",
        f"Cases: {len(cases)} document-disjoint development cases ({len(positives)} positive, {len(negatives)} absence diagnostics).",
        "",
        f"Repetitions: {manifest['config'].get('repetitions', 1)}. Models are loaded once; every case and lane is executed once per repetition.",
        "",
        "## Quality",
        "",
        "| Lane | Clause hit@1 | Clause hit@3 | Clause hit@5 | Clause hit@10 | Passage recall@5 | MRR | Gold density@5 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    aggregates: dict[str, dict[str, float]] = {}
    for lane in manifest["lanes"]:
        lane_rows = positive_rows(records, lane)
        aggregate = {
            "clause1": mean(row["metrics"]["clauseHitAt"]["1"] for row in lane_rows),
            "clause3": mean(row["metrics"]["clauseHitAt"]["3"] for row in lane_rows),
            "clause5": mean(row["metrics"]["clauseHitAt"]["5"] for row in lane_rows),
            "clause10": mean(row["metrics"]["clauseHitAt"]["10"] for row in lane_rows),
            "passage5": mean(row["metrics"]["passageRecallAt"]["5"] for row in lane_rows),
            "mrr": mean(row["metrics"]["reciprocalRank"] for row in lane_rows),
            "density5": mean(row["metrics"]["goldDensityAt5"] for row in lane_rows),
        }
        aggregates[lane] = aggregate
        lines.append(
            f"| {LANE_LABELS[lane]} | {pct(aggregate['clause1'])} | {pct(aggregate['clause3'])} | "
            f"{pct(aggregate['clause5'])} | {pct(aggregate['clause10'])} | {pct(aggregate['passage5'])} | "
            f"{aggregate['mrr']:.3f} | {pct(aggregate['density5'])} |"
        )

    lines.extend(
        [
            "",
            "Primary metric: macro clause hit rate at five over the 11 positive cases. Absence cases are excluded because top-k retrieval cannot prove absence.",
            "",
            "## Paired clause-hit comparison with BM25",
            "",
            "| Treatment | Mean difference | 95% bootstrap interval |",
            "| --- | ---: | ---: |",
        ]
    )
    control = clause_scores(records, "bm25", positives)
    for lane in manifest["lanes"]:
        if lane == "bm25":
            continue
        difference, low, high = bootstrap_difference(clause_scores(records, lane, positives), control)
        lines.append(f"| {LANE_LABELS[lane]} | {points(difference)} | [{points(low)}, {points(high)}] |")

    lines.extend(
        [
            "",
            "The interval resamples 11 source documents. It is necessarily wide and is development guidance, not confirmatory evidence.",
            "Repeated executions are averaged within each source document before resampling; they do not increase the number of independent cases.",
        ]
    )

    lines.extend(
        [
            "",
            "## Adjacent-context replay",
            "",
            "| Lane | Seed clause hit@5 | Clause hit with ±1 passage | Mean passages exposed | Mean words exposed | Word multiplier |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for lane in manifest["lanes"]:
        context = adjacent_context_summary(records, lane, positives)
        lines.append(
            f"| {LANE_LABELS[lane]} | {pct(context.seed_clause_hit)} | "
            f"{pct(context.expanded_clause_hit)} | {context.mean_expanded_passages:.1f} | "
            f"{context.mean_expanded_words:.0f} | {context.word_multiplier:.2f}× |"
        )
    lines.extend(
        [
            "",
            "This is a deterministic replay of the stored top-five rankings. Each seed exposes itself and its immediate previous and next passage, with duplicates removed. It diagnoses passage-boundary failures but increases the context budget, so it is not a same-budget retrieval improvement or a new benchmark run.",
        ]
    )

    lines.extend(
        [
            "",
            "## Performance",
            "",
            "| Lane | Mean index time | Mean warm query | p95 warm query | Max warm query |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for lane in manifest["lanes"]:
        lane_rows = rows(records, lane)
        query_times = sorted(row["timings"]["queryMs"] for row in lane_rows)
        lines.append(
            f"| {LANE_LABELS[lane]} | {mean(row['timings']['indexMs'] for row in lane_rows):.1f} ms | "
            f"{mean(query_times):.1f} ms | {percentile(query_times, 0.95):.1f} ms | {max(query_times):.1f} ms |"
        )

    repetitions = manifest["config"].get("repetitions", 1)
    if repetitions > 1:
        lines.extend(
            [
                "",
                "## Ranking consistency",
                "",
                "| Lane | Cases with one identical top-10 ranking | Consistency |",
                "| --- | ---: | ---: |",
            ]
        )
        for lane in manifest["lanes"]:
            stable, total = ranking_consistency(records, lane)
            lines.append(f"| {LANE_LABELS[lane]} | {stable}/{total} | {pct(stable / total)} |")
        lines.extend(
            [
                "",
                "Consistency is an operational determinism check, not additional accuracy evidence.",
            ]
        )

    load = manifest.get("modelLoadMs", {})
    lines.extend(
        [
            "",
            f"Dense model load: {load.get('dense_ms', 0):.0f} ms. Reranker load: {load.get('reranker_ms', 0):.0f} ms. "
            f"Peak process RSS: {manifest.get('peakRssBytes', 0) / (1024 ** 3):.2f} GiB.",
            "",
            "Passage indexing is reported separately from warm question latency. Model loading is paid once for the run, not once per case.",
            "",
            "## Development misses at five",
            "",
        ]
    )
    for lane in manifest["lanes"]:
        by_case = group_rows_by_case(positive_rows(records, lane))
        misses = [
            (case_id, case_rows)
            for case_id, case_rows in by_case.items()
            if mean(row["metrics"]["clauseHitAt"]["5"] for row in case_rows) < 1
        ]
        lines.append(f"### {LANE_LABELS[lane]} ({len(misses)} cases)")
        lines.append("")
        if not misses:
            lines.append("- None.")
        else:
            for case_id, case_rows in misses:
                row = case_rows[0]
                ids = ", ".join(str(item["passageId"]) for item in row["ranked"][:5])
                clause_hit = mean(item["metrics"]["clauseHitAt"]["5"] for item in case_rows)
                candidate_hit = mean(item["candidatePoolClauseHit"] for item in case_rows)
                lines.append(
                    f"- `{case_id}`: first-repetition top five [{ids}], mean clause hit "
                    f"{pct(clause_hit)}; mean candidate-pool clause hit {pct(candidate_hit)}."
                )
        lines.append("")

    model_lines = []
    if "dense" in manifest["models"]:
        dense = manifest["models"]["dense"]
        model_lines.append(f"- Dense model: `{dense['id']}@{dense['revision']}`")
    if "reranker" in manifest["models"]:
        reranker = manifest["models"]["reranker"]
        model_lines.append(f"- Reranker: `{reranker['id']}@{reranker['revision']}`")
    lines.extend(
        [
            "## Reproducibility",
            "",
            f"- Git revision: `{manifest['git']['rev']}`",
            f"- Dirty files at run time: {', '.join(f'`{path}`' for path in manifest['git']['dirty']) or 'none'}",
            f"- Case hash: `{manifest['casesSha256']}`",
            f"- Dependency lock hash: `{manifest['dependencyLockSha256']}`",
            f"- Result hash: `{manifest['resultsSha256']}`",
            *model_lines,
            f"- Device: `{manifest['config']['device']}`, dtype `{manifest['config']['dtype']}`, batch size {manifest['config']['batchSize']}",
            f"- Python: `{manifest['environment']['python']}` on `{manifest['environment']['platform']}`",
            "",
            "The case-level JSONL and run receipt in the run directory are the source of truth. This report is generated from them.",
            "",
        ]
    )
    return "\n".join(lines)


def rows(records: Sequence[dict[str, Any]], lane: str) -> list[dict[str, Any]]:
    return [row for row in records if row["lane"] == lane]


def positive_rows(records: Sequence[dict[str, Any]], lane: str) -> list[dict[str, Any]]:
    return [row for row in rows(records, lane) if row["positive"]]


def clause_scores(
    records: Sequence[dict[str, Any]],
    lane: str,
    cases: Sequence[RetrievalCase],
) -> list[float]:
    by_case = group_rows_by_case(positive_rows(records, lane))
    return [mean(row["metrics"]["clauseHitAt"]["5"] for row in by_case[case.id]) for case in cases]


def group_rows_by_case(records: Sequence[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in records:
        grouped.setdefault(row["caseId"], []).append(row)
    return grouped


def ranking_consistency(records: Sequence[dict[str, Any]], lane: str) -> tuple[int, int]:
    grouped = group_rows_by_case(rows(records, lane))
    stable = sum(
        len({tuple(item["passageId"] for item in row["ranked"]) for row in case_rows}) == 1
        for case_rows in grouped.values()
    )
    return stable, len(grouped)


def adjacent_context_summary(
    records: Sequence[dict[str, Any]],
    lane: str,
    cases: Sequence[RetrievalCase],
    rank: int = 5,
    radius: int = 1,
) -> AdjacentContextSummary:
    if rank <= 0 or radius < 0:
        raise ValueError("context replay rank must be positive and radius must be non-negative")
    by_case = group_rows_by_case(positive_rows(records, lane))
    seed_hits: list[float] = []
    expanded_hits: list[float] = []
    seed_words: list[float] = []
    expanded_words: list[float] = []
    expanded_passages: list[float] = []
    for case in cases:
        case_rows = by_case.get(case.id)
        if not case_rows:
            raise ValueError(f"missing positive record for {case.id} in lane {lane}")
        row_seed_hits: list[float] = []
        row_expanded_hits: list[float] = []
        row_seed_words: list[int] = []
        row_expanded_words: list[int] = []
        row_expanded_passages: list[int] = []
        for row in case_rows:
            seeds = {item["passageId"] for item in row["ranked"][:rank]}
            expanded = {
                passage_id
                for seed in seeds
                for passage_id in range(max(1, seed - radius), min(len(case.passages), seed + radius) + 1)
            }
            row_seed_hits.append(clause_hit(case, seeds))
            row_expanded_hits.append(clause_hit(case, expanded))
            row_seed_words.append(context_words(case, seeds))
            row_expanded_words.append(context_words(case, expanded))
            row_expanded_passages.append(len(expanded))
        seed_hits.append(mean(row_seed_hits))
        expanded_hits.append(mean(row_expanded_hits))
        seed_words.append(mean(row_seed_words))
        expanded_words.append(mean(row_expanded_words))
        expanded_passages.append(mean(row_expanded_passages))
    return AdjacentContextSummary(
        seed_clause_hit=mean(seed_hits),
        expanded_clause_hit=mean(expanded_hits),
        mean_seed_words=mean(seed_words),
        mean_expanded_words=mean(expanded_words),
        mean_expanded_passages=mean(expanded_passages),
    )


def clause_hit(case: RetrievalCase, passage_ids: set[int]) -> float:
    return mean(1.0 if clause & passage_ids else 0.0 for clause in case.clauses)


def context_words(case: RetrievalCase, passage_ids: set[int]) -> int:
    return sum(len(case.passages[passage_id - 1].text.split()) for passage_id in passage_ids)


def percentile(values: Sequence[float], quantile: float) -> float:
    if not values:
        raise ValueError("percentile needs values")
    index = max(0, min(len(values) - 1, int(np_ceil(quantile * len(values))) - 1))
    return values[index]


def np_ceil(value: float) -> int:
    return int(value) if value == int(value) else int(value) + 1


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def points(value: float) -> str:
    return f"{value * 100:+.1f} points"
