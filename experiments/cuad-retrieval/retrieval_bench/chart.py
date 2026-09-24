from __future__ import annotations

from html import escape
from statistics import mean
from typing import Any, Sequence

from .report import LANE_LABELS, positive_rows


def build_chart(manifest: dict[str, Any], records: Sequence[dict[str, Any]]) -> str:
    rows = []
    for lane in manifest["lanes"]:
        lane_rows = positive_rows(records, lane)
        hit_at_five = mean(row["metrics"]["clauseHitAt"]["5"] for row in lane_rows)
        reciprocal_rank = mean(row["metrics"]["reciprocalRank"] for row in lane_rows)
        rows.append((LANE_LABELS[lane], hit_at_five, reciprocal_rank))

    bars = "\n".join(
        f"""<tr>
          <th scope="row">{escape(label)}</th>
          <td><span class="bar" style="--value:{hit * 100:.1f}%"></span><span>{hit * 100:.1f}%</span></td>
          <td>{mrr:.3f}</td>
        </tr>"""
        for label, hit, mrr in rows
    )
    run_id = escape(str(manifest["runId"]))
    repetitions = int(manifest["config"].get("repetitions", 1))
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CUAD retrieval development result</title>
  <style>
    :root {{ color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }}
    body {{ max-width: 880px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }}
    .warning {{ border-left: .3rem solid #d97706; padding: .75rem 1rem; background: color-mix(in srgb, #d97706 12%, transparent); }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 1.5rem; }}
    th, td {{ padding: .75rem; border-bottom: 1px solid #8886; text-align: left; }}
    td:nth-child(2) {{ display: grid; grid-template-columns: minmax(8rem, 1fr) 4rem; gap: .75rem; align-items: center; }}
    .bar {{ display: block; height: .85rem; border-radius: 999px; background: linear-gradient(90deg, #2563eb var(--value), #8883 var(--value)); }}
    code {{ font-size: .9em; }}
  </style>
</head>
<body>
  <h1>CUAD retrieval development result</h1>
  <p class="warning"><strong>Development evidence only.</strong> This is not a locked-test result or a reportable benchmark claim.</p>
  <p>Run <code>{run_id}</code>; {repetitions} repetition(s). Repetitions test operational consistency and do not increase the accuracy sample size.</p>
  <table>
    <thead><tr><th>Lane</th><th>Macro clause hit@5</th><th>MRR</th></tr></thead>
    <tbody>
{bars}
    </tbody>
  </table>
  <p>The generated <code>report.md</code>, <code>results.jsonl</code>, and <code>run.json</code> in this run directory are the audit trail.</p>
</body>
</html>
"""
