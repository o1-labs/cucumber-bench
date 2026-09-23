from __future__ import annotations

import json
from pathlib import Path

import pytest

from retrieval_bench.cases import load_cases, parse_case


def public_case(case_id: str = "cuad-hard-dev-100") -> dict:
    docs = [{"title": f"part {index}", "text": f"passage {index}"} for index in range(1, 11)]
    return {
        "id": case_id,
        "suite": "cuad-hard-dev",
        "input": "Question: Is there a termination clause?\n\nDocument [1]: passage 1",
        "docs": docs,
        "_source": "pinned source",
    }


def private_case(case_id: str = "cuad-hard-dev-100") -> dict:
    return {"id": case_id, "graders": ["clause-recall"], "clauses": [{"text": "x", "passages": [2]}]}


def test_parse_case_extracts_query_and_converts_gold_to_one_based() -> None:
    case = parse_case(public_case(), private_case(), "case.json")
    assert case.query == "Is there a termination clause?"
    assert case.gold_passages == frozenset({3})
    assert len(case.passages) == 10


def test_parse_case_rejects_out_of_range_gold() -> None:
    private = private_case()
    private["clauses"][0]["passages"] = [10]
    with pytest.raises(ValueError, match="invalid passage"):
        parse_case(public_case(), private, "case.json")


def test_load_cases_hash_changes_with_input(tmp_path: Path) -> None:
    public_path = tmp_path / "cuad-hard-dev-100.public.json"
    private_path = tmp_path / "cuad-hard-dev-100.private.json"
    public_path.write_text(json.dumps(public_case()), encoding="utf-8")
    private_path.write_text(json.dumps(private_case()), encoding="utf-8")
    cases, first_hash = load_cases(tmp_path)
    assert len(cases) == 1
    public = public_case()
    public["docs"][0]["text"] = "changed"
    public_path.write_text(json.dumps(public), encoding="utf-8")
    _, second_hash = load_cases(tmp_path)
    assert first_hash != second_hash
