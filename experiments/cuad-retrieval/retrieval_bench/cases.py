from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any

from .core import Passage


QUERY_MARKER = "\n\nDocument [1]"


@dataclass(frozen=True)
class RetrievalCase:
    id: str
    query: str
    passages: tuple[Passage, ...]
    clauses: tuple[frozenset[int], ...]
    source: str

    @property
    def positive(self) -> bool:
        return bool(self.clauses)

    @property
    def gold_passages(self) -> frozenset[int]:
        return frozenset(passage for clause in self.clauses for passage in clause)


def load_cases(case_dir: Path) -> tuple[list[RetrievalCase], str]:
    public_files = sorted(case_dir.glob("*.public.json"))
    if not public_files:
        raise ValueError(f"no public cases under {case_dir}")
    digest = hashlib.sha256()
    cases: list[RetrievalCase] = []
    for public_path in public_files:
        private_path = public_path.with_name(public_path.name.replace(".public.json", ".private.json"))
        public_bytes = public_path.read_bytes()
        private_bytes = private_path.read_bytes()
        digest.update(public_path.name.encode())
        digest.update(public_bytes)
        digest.update(private_path.name.encode())
        digest.update(private_bytes)
        public = json.loads(public_bytes)
        private = json.loads(private_bytes)
        cases.append(parse_case(public, private, public_path.name))
    return cases, digest.hexdigest()


def parse_case(public: dict[str, Any], private: dict[str, Any], context: str) -> RetrievalCase:
    case_id = require_string(public.get("id"), f"{context}: public id")
    if private.get("id") != case_id:
        raise ValueError(f"{context}: public/private id mismatch")
    if public.get("suite") != "cuad-hard-dev":
        raise ValueError(f"{context}: retrieval development run accepts only cuad-hard-dev")
    raw_input = require_string(public.get("input"), f"{context}: input")
    if QUERY_MARKER not in raw_input:
        raise ValueError(f"{context}: input does not contain the first document marker")
    query = raw_input.split(QUERY_MARKER, 1)[0]
    if not query.startswith("Question: "):
        raise ValueError(f"{context}: input does not start with Question")
    query = query.removeprefix("Question: ").strip()
    raw_docs = public.get("docs")
    if not isinstance(raw_docs, list) or len(raw_docs) < 10:
        raise ValueError(f"{context}: needs at least ten passages")
    passages = tuple(
        Passage(
            id=index,
            title=require_string(raw.get("title"), f"{context}: passage {index} title"),
            text=require_string(raw.get("text"), f"{context}: passage {index} text"),
        )
        for index, raw in enumerate(raw_docs, start=1)
        if isinstance(raw, dict)
    )
    if len(passages) != len(raw_docs):
        raise ValueError(f"{context}: every passage must be an object")
    raw_clauses = private.get("clauses")
    if not isinstance(raw_clauses, list):
        raise ValueError(f"{context}: private case needs clauses")
    clauses: list[frozenset[int]] = []
    for clause_index, raw_clause in enumerate(raw_clauses, start=1):
        if not isinstance(raw_clause, dict) or not isinstance(raw_clause.get("passages"), list):
            raise ValueError(f"{context}: clause {clause_index} needs passages")
        passage_ids = raw_clause["passages"]
        if not passage_ids or any(not isinstance(value, int) or value < 0 or value >= len(passages) for value in passage_ids):
            raise ValueError(f"{context}: clause {clause_index} has invalid passage indices")
        clauses.append(frozenset(value + 1 for value in passage_ids))
    source = require_string(public.get("_source"), f"{context}: source")
    return RetrievalCase(case_id, query, passages, tuple(clauses), source)


def require_string(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{context} must be a non-empty string")
    return value
