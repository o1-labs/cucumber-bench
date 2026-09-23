from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from math import log
import re
from typing import Iterable, Protocol, Sequence

import numpy as np
from numpy.typing import NDArray


TOKEN_RE = re.compile(r"[^\W_]+(?:_[^\W_]+)*", re.UNICODE)
BM25_K1 = 1.2
BM25_B = 0.75


@dataclass(frozen=True)
class Passage:
    id: int
    title: str
    text: str


@dataclass(frozen=True)
class RankedPassage:
    passage_id: int
    score: float
    bm25_rank: int | None = None
    dense_rank: int | None = None


@dataclass(frozen=True)
class RetrievalRequest:
    query: str
    passages: tuple[Passage, ...]
    limit: int


class Retriever(Protocol):
    def retrieve(self, request: RetrievalRequest) -> list[RankedPassage]: ...


def tokenize(text: str) -> list[str]:
    return [match.group(0).lower() for match in TOKEN_RE.finditer(text)]


class Bm25Retriever:
    def __init__(self, passages: Sequence[Passage], k1: float = BM25_K1, b: float = BM25_B):
        if not passages:
            raise ValueError("BM25 needs at least one passage")
        self._passages = tuple(passages)
        self._k1 = k1
        self._b = b
        self._tokens = [tokenize(passage.text) for passage in passages]
        self._counts = [Counter(tokens) for tokens in self._tokens]
        self._avg_length = sum(map(len, self._tokens)) / len(self._tokens)
        self._document_frequency: Counter[str] = Counter()
        for tokens in self._tokens:
            self._document_frequency.update(set(tokens))

    def retrieve(self, request: RetrievalRequest) -> list[RankedPassage]:
        if request.passages != self._passages:
            raise ValueError("BM25 request passages differ from its index")
        if request.limit <= 0:
            raise ValueError("retrieval limit must be positive")
        terms = set(tokenize(request.query))
        count = len(self._passages)
        scored: list[RankedPassage] = []
        for passage, tokens, frequencies in zip(self._passages, self._tokens, self._counts, strict=True):
            score = 0.0
            for term in terms:
                frequency = frequencies.get(term, 0)
                if not frequency:
                    continue
                document_frequency = self._document_frequency[term]
                inverse_frequency = log(1 + (count - document_frequency + 0.5) / (document_frequency + 0.5))
                length_normalization = 1 - self._b + self._b * len(tokens) / self._avg_length
                score += inverse_frequency * (
                    frequency * (self._k1 + 1) / (frequency + self._k1 * length_normalization)
                )
            scored.append(RankedPassage(passage.id, score))
        ranked = sorted(scored, key=lambda item: (-item.score, item.passage_id))[: request.limit]
        return [
            RankedPassage(item.passage_id, item.score, bm25_rank=rank)
            for rank, item in enumerate(ranked, start=1)
        ]


def rank_dense(
    passage_ids: Sequence[int],
    query_embedding: NDArray[np.floating],
    passage_embeddings: NDArray[np.floating],
    limit: int,
) -> list[RankedPassage]:
    if limit <= 0:
        raise ValueError("retrieval limit must be positive")
    if len(passage_ids) != len(passage_embeddings):
        raise ValueError("passage ids and embeddings must have the same length")
    if passage_embeddings.ndim != 2 or query_embedding.ndim != 1:
        raise ValueError("dense ranking expects one query vector and a passage matrix")
    if passage_embeddings.shape[1] != query_embedding.shape[0]:
        raise ValueError("query and passage embedding dimensions differ")
    scores = passage_embeddings @ query_embedding
    ordered = sorted(zip(passage_ids, scores.tolist(), strict=True), key=lambda item: (-item[1], item[0]))[:limit]
    return [
        RankedPassage(passage_id, float(score), dense_rank=rank)
        for rank, (passage_id, score) in enumerate(ordered, start=1)
    ]


def reciprocal_rank_fusion(
    bm25: Sequence[RankedPassage],
    dense: Sequence[RankedPassage],
    limit: int,
    constant: int = 60,
) -> list[RankedPassage]:
    if limit <= 0 or constant <= 0:
        raise ValueError("fusion limit and constant must be positive")
    bm25_ranks = {item.passage_id: rank for rank, item in enumerate(bm25, start=1)}
    dense_ranks = {item.passage_id: rank for rank, item in enumerate(dense, start=1)}
    passage_ids = bm25_ranks.keys() | dense_ranks.keys()
    scored: list[RankedPassage] = []
    for passage_id in passage_ids:
        bm25_rank = bm25_ranks.get(passage_id)
        dense_rank = dense_ranks.get(passage_id)
        score = (0 if bm25_rank is None else 1 / (constant + bm25_rank)) + (
            0 if dense_rank is None else 1 / (constant + dense_rank)
        )
        scored.append(RankedPassage(passage_id, score, bm25_rank=bm25_rank, dense_rank=dense_rank))
    return sorted(
        scored,
        key=lambda item: (
            -item.score,
            min(rank for rank in (item.bm25_rank, item.dense_rank) if rank is not None),
            item.passage_id,
        ),
    )[:limit]


def rerank(
    candidates: Sequence[RankedPassage],
    scores: Sequence[float],
    limit: int,
) -> list[RankedPassage]:
    if len(candidates) != len(scores):
        raise ValueError("reranker candidates and scores must have the same length")
    hybrid_rank = {item.passage_id: rank for rank, item in enumerate(candidates, start=1)}
    rescored = [
        RankedPassage(item.passage_id, float(score), item.bm25_rank, item.dense_rank)
        for item, score in zip(candidates, scores, strict=True)
    ]
    return sorted(
        rescored,
        key=lambda item: (-item.score, hybrid_rank[item.passage_id], item.passage_id),
    )[:limit]


def passage_ids(items: Iterable[RankedPassage]) -> list[int]:
    return [item.passage_id for item in items]
