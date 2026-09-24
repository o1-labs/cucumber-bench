from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Sequence

import numpy as np
from numpy.typing import NDArray
import torch
import torch.nn.functional as functional
from transformers import AutoModel, AutoModelForSequenceClassification, AutoTokenizer

from .timing import elapsed_ms


BGE_MODEL = "BAAI/bge-m3"
BGE_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"
RERANKER_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
MAX_LENGTH = 8192


@dataclass(frozen=True)
class LoadTiming:
    dense_ms: float
    reranker_ms: float


class LocalModels:
    def __init__(
        self,
        device: str,
        batch_size: int,
        cache_dir: str | None = None,
        load_reranker: bool = True,
    ):
        started = time.perf_counter()
        self._dense_tokenizer = AutoTokenizer.from_pretrained(
            BGE_MODEL,
            revision=BGE_REVISION,
            cache_dir=cache_dir,
        )
        self._dense = AutoModel.from_pretrained(
            BGE_MODEL,
            revision=BGE_REVISION,
            cache_dir=cache_dir,
        ).to(device)
        self._dense.eval()
        dense_ms = elapsed_ms(started)
        reranker_ms = 0.0
        self._reranker_tokenizer = None
        self._reranker = None
        if load_reranker:
            started = time.perf_counter()
            self._reranker_tokenizer = AutoTokenizer.from_pretrained(
                RERANKER_MODEL,
                revision=RERANKER_REVISION,
                cache_dir=cache_dir,
            )
            self._reranker = AutoModelForSequenceClassification.from_pretrained(
                RERANKER_MODEL,
                revision=RERANKER_REVISION,
                cache_dir=cache_dir,
            ).to(device)
            self._reranker.eval()
            reranker_ms = elapsed_ms(started)
        self.load_timing = LoadTiming(dense_ms=dense_ms, reranker_ms=reranker_ms)
        self.batch_size = batch_size
        self.device = device

    def encode_query(self, query: str) -> tuple[NDArray[np.float32], float, int]:
        truncations = self._count_dense_truncations([query])
        embeddings, duration = self._encode([query], batch_size=1)
        return embeddings[0], duration, truncations

    def encode_passages(self, passages: Sequence[str]) -> tuple[NDArray[np.float32], float, int]:
        truncations = self._count_dense_truncations(passages)
        embeddings, duration = self._encode(passages, batch_size=self.batch_size)
        return embeddings, duration, truncations

    def rerank(self, query: str, passages: Sequence[str]) -> tuple[list[float], float, int]:
        if self._reranker is None or self._reranker_tokenizer is None:
            raise ValueError("reranker was not loaded")
        pairs = [(query, passage) for passage in passages]
        truncations = self._count_pair_truncations(pairs)
        started = time.perf_counter()
        scores: list[float] = []
        with torch.inference_mode():
            for offset in range(0, len(pairs), self.batch_size):
                batch = pairs[offset : offset + self.batch_size]
                encoded = self._reranker_tokenizer(
                    [query for query, _ in batch],
                    [passage for _, passage in batch],
                    padding=True,
                    truncation=True,
                    max_length=MAX_LENGTH,
                    return_tensors="pt",
                ).to(self.device)
                logits = self._reranker(**encoded).logits.reshape(-1).float().cpu().tolist()
                scores.extend(float(value) for value in logits)
        return scores, elapsed_ms(started), truncations

    def _encode(self, texts: Sequence[str], batch_size: int) -> tuple[NDArray[np.float32], float]:
        started = time.perf_counter()
        batches: list[NDArray[np.float32]] = []
        with torch.inference_mode():
            for offset in range(0, len(texts), batch_size):
                batch = list(texts[offset : offset + batch_size])
                encoded = self._dense_tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=MAX_LENGTH,
                    return_tensors="pt",
                ).to(self.device)
                hidden = self._dense(**encoded).last_hidden_state[:, 0]
                embeddings = functional.normalize(hidden.float(), p=2, dim=1)
                batches.append(embeddings.cpu().numpy().astype(np.float32, copy=False))
        return np.concatenate(batches), elapsed_ms(started)

    def _count_dense_truncations(self, texts: Sequence[str]) -> int:
        return sum(
            len(self._dense_tokenizer(text, add_special_tokens=True, truncation=False)["input_ids"]) > MAX_LENGTH
            for text in texts
        )

    def _count_pair_truncations(self, pairs: Sequence[tuple[str, str]]) -> int:
        return sum(
            len(self._reranker_tokenizer(query, passage, add_special_tokens=True, truncation=False)["input_ids"]) > MAX_LENGTH
            for query, passage in pairs
        )
