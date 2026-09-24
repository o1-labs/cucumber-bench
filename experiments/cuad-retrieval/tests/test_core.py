from __future__ import annotations

import numpy as np
import pytest

from retrieval_bench.core import (
    Bm25Retriever,
    Passage,
    RankedPassage,
    RetrievalRequest,
    rank_dense,
    reciprocal_rank_fusion,
    rerank,
    tokenize,
)


def passages() -> tuple[Passage, ...]:
    return (
        Passage(1, "one", "The supplier may terminate the agreement after material breach."),
        Passage(2, "two", "Invoices are payable within thirty days."),
        Passage(3, "three", "Either party may end the contract before expiration."),
    )


def test_bm25_ranks_exact_terms_and_breaks_ties_by_passage_id() -> None:
    items = passages()
    ranked = Bm25Retriever(items).retrieve(RetrievalRequest("terminate agreement", items, 3))
    assert [item.passage_id for item in ranked] == [1, 2, 3]
    assert ranked[0].score > ranked[1].score == ranked[2].score
    assert [item.bm25_rank for item in ranked] == [1, 2, 3]


def test_tokenize_preserves_unicode_words_and_internal_underscores() -> None:
    assert tokenize("Sona erdi: taraflar, party_name 2026") == ["sona", "erdi", "taraflar", "party_name", "2026"]


def test_dense_ranking_uses_dot_product_and_stable_ties() -> None:
    query = np.asarray([1.0, 0.0], dtype=np.float32)
    matrix = np.asarray([[0.5, 0.5], [0.9, 0.1], [0.5, -0.5]], dtype=np.float32)
    ranked = rank_dense([1, 2, 3], query, matrix, 3)
    assert [item.passage_id for item in ranked] == [2, 1, 3]
    assert [item.dense_rank for item in ranked] == [1, 2, 3]


def test_rrf_rewards_agreement_and_uses_deterministic_ties() -> None:
    bm25 = [RankedPassage(1, 9), RankedPassage(2, 8), RankedPassage(3, 7)]
    dense = [RankedPassage(2, 0.9), RankedPassage(1, 0.8), RankedPassage(4, 0.7)]
    ranked = reciprocal_rank_fusion(bm25, dense, 4)
    assert [item.passage_id for item in ranked] == [1, 2, 3, 4]
    assert ranked[0].bm25_rank == 1 and ranked[0].dense_rank == 2


def test_rerank_uses_hybrid_order_for_equal_scores() -> None:
    candidates = [RankedPassage(7, 0.3), RankedPassage(2, 0.2), RankedPassage(9, 0.1)]
    ranked = rerank(candidates, [0.5, 0.8, 0.8], 3)
    assert [item.passage_id for item in ranked] == [2, 9, 7]


def test_dense_ranking_rejects_dimension_mismatch() -> None:
    with pytest.raises(ValueError, match="dimensions differ"):
        rank_dense([1], np.ones(3), np.ones((1, 2)), 1)
