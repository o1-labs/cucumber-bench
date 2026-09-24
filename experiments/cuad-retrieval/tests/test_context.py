from __future__ import annotations

import pytest

from retrieval_bench.context import select_adjacent_context
from retrieval_bench.core import Passage


def passages(count: int = 10, words: int = 10) -> tuple[Passage, ...]:
    return tuple(Passage(index, f"part {index}", "word " * words) for index in range(1, count + 1))


def test_context_selection_adds_neighbors_deduplicates_and_returns_document_order() -> None:
    selection = select_adjacent_context(
        passages(),
        (5, 4, 1, 9, 10),
        word_budget=200,
    )
    assert selection.seed_passage_ids == (5, 4, 1, 9, 10)
    assert selection.passage_ids == (1, 2, 3, 4, 5, 6, 8, 9, 10)
    assert selection.seed_word_count == 50
    assert selection.word_count == 90


def test_context_selection_obeys_budget_without_dropping_seeds() -> None:
    selection = select_adjacent_context(
        passages(),
        (5, 1, 2, 3, 4),
        word_budget=60,
    )
    assert selection.passage_ids == (1, 2, 3, 4, 5, 6)
    assert selection.word_count == 60


def test_context_selection_rejects_a_budget_smaller_than_the_seed_set() -> None:
    with pytest.raises(ValueError, match="seed passages need 50 words"):
        select_adjacent_context(passages(), (1, 2, 3, 4, 5), word_budget=49)


def test_context_selection_rejects_noncontiguous_passage_ids() -> None:
    invalid = (Passage(1, "part 1", "word"), Passage(3, "part 3", "word"))
    with pytest.raises(ValueError, match="contiguous one-based ids"):
        select_adjacent_context(invalid, (1,), seed_limit=1)


@pytest.mark.parametrize(
    "ranked,kwargs",
    [
        ((1, 2, 3, 4), {}),
        ((1, 2, 3, 4, 4), {}),
        ((0, 1, 2, 3, 4), {}),
        ((1, 2, 3, 4, 5), {"seed_limit": 0}),
        ((1, 2, 3, 4, 5), {"radius": -1}),
        ((1, 2, 3, 4, 5), {"word_budget": 0}),
    ],
)
def test_context_selection_rejects_invalid_inputs(ranked: tuple[int, ...], kwargs: dict[str, int]) -> None:
    with pytest.raises(ValueError):
        select_adjacent_context(passages(), ranked, **kwargs)
