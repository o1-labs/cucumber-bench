from __future__ import annotations

import time


def elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000
