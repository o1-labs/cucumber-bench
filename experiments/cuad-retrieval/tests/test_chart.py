from __future__ import annotations

from retrieval_bench.chart import build_chart


def test_chart_is_generated_from_case_records_and_labels_development_status() -> None:
    manifest = {
        "runId": "run<&>",
        "lanes": ["bm25", "hybrid"],
        "config": {"repetitions": 3},
    }
    records = [
        {
            "lane": lane,
            "positive": True,
            "metrics": {"clauseHitAt": {"5": hit}, "reciprocalRank": hit},
        }
        for lane, hit in (("bm25", 0.25), ("hybrid", 0.5))
    ]
    chart = build_chart(manifest, records)
    assert "Development evidence only" in chart
    assert "run&lt;&amp;&gt;" in chart
    assert "BM25 + dense RRF" in chart
    assert "50.0%" in chart
