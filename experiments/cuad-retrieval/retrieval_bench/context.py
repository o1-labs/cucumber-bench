from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .core import Passage


CONTEXT_SEED_LIMIT = 5
CONTEXT_RADIUS = 1
CONTEXT_WORD_BUDGET = 3000


@dataclass(frozen=True)
class ContextSelection:
    seed_passage_ids: tuple[int, ...]
    passage_ids: tuple[int, ...]
    seed_word_count: int
    word_count: int


def select_adjacent_context(
    passages: Sequence[Passage],
    ranked_passage_ids: Sequence[int],
    *,
    seed_limit: int = CONTEXT_SEED_LIMIT,
    radius: int = CONTEXT_RADIUS,
    word_budget: int = CONTEXT_WORD_BUDGET,
) -> ContextSelection:
    if not passages:
        raise ValueError("context selection needs passages")
    if tuple(passage.id for passage in passages) != tuple(range(1, len(passages) + 1)):
        raise ValueError("context passages must use contiguous one-based ids in document order")
    if seed_limit <= 0 or radius < 0 or word_budget <= 0:
        raise ValueError("context seed limit and word budget must be positive; radius must be non-negative")
    seeds = tuple(ranked_passage_ids[:seed_limit])
    if len(seeds) != seed_limit or len(set(seeds)) != seed_limit:
        raise ValueError(f"context selection needs {seed_limit} unique ranked passage ids")
    if any(passage_id < 1 or passage_id > len(passages) for passage_id in seeds):
        raise ValueError("context seed passage id is out of range")

    words = {passage.id: len(passage.text.split()) for passage in passages}
    selected = set(seeds)
    seed_word_count = sum(words[passage_id] for passage_id in selected)
    word_count = seed_word_count
    if seed_word_count > word_budget:
        raise ValueError(f"seed passages need {seed_word_count} words, above the {word_budget}-word context budget")

    for distance in range(1, radius + 1):
        for seed in seeds:
            for passage_id in (seed - distance, seed + distance):
                if passage_id < 1 or passage_id > len(passages) or passage_id in selected:
                    continue
                passage_words = words[passage_id]
                if word_count + passage_words > word_budget:
                    continue
                selected.add(passage_id)
                word_count += passage_words

    return ContextSelection(
        seed_passage_ids=seeds,
        passage_ids=tuple(sorted(selected)),
        seed_word_count=seed_word_count,
        word_count=word_count,
    )
