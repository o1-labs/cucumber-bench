# LongBench v2 summary

Run: 2026-09-15T07-54-40-138Z; suites longbench-v2; cases 503; reps 1

Accuracy is correct / eligible. Eligible is every run but the unsupported ones: failed and invalid runs stay in the denominator. Coverage is eligible / runs: the share of the selected cases the system took whole. Unsupported: the document did not fit the context (context_overflow).

## lb2-direct

Model qwen/qwen3.6-35b-a3b; overflow skip; context 262144 tokens, output 16384; reasoning {"enabled":true}; prompt 0shot.txt@c5ea10bcd06285223c58dfed76bbc92d22273709; harness version 1.

| selected | runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 503 | 503 | 400 | 79.5% | 217 | 162 | 15 | 6 | 103 | 54.3% |

### By difficulty

| difficulty | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| easy | 147 | 89 | 5 | 1 | 45 | 60.5% | 76.6% |
| hard | 253 | 128 | 10 | 5 | 58 | 50.6% | 81.4% |

### By length

| length | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| long | 18 | 7 | 0 | 5 | 90 | 38.9% | 16.7% |
| medium | 203 | 102 | 13 | 1 | 12 | 50.2% | 94.4% |
| short | 179 | 108 | 2 | 0 | 1 | 60.3% | 99.4% |

### By domain

| domain | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Code Repository Understanding | 18 | 11 | 0 | 0 | 32 | 61.1% | 36.0% |
| Long In-context Learning | 54 | 31 | 6 | 0 | 27 | 57.4% | 66.7% |
| Long Structured Data Understanding | 19 | 10 | 2 | 1 | 14 | 52.6% | 57.6% |
| Long-dialogue History Understanding | 39 | 27 | 1 | 0 | 0 | 69.2% | 100.0% |
| Multi-Document QA | 111 | 59 | 2 | 4 | 14 | 53.2% | 88.8% |
| Single-Document QA | 159 | 79 | 4 | 1 | 16 | 49.7% | 90.9% |

### By sub-domain

| sub-domain | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Academic | 85 | 46 | 0 | 0 | 9 | 54.1% | 90.4% |
| Agent history QA | 20 | 16 | 0 | 0 | 0 | 80.0% | 100.0% |
| Code repo QA | 18 | 11 | 0 | 0 | 32 | 61.1% | 36.0% |
| Detective | 22 | 3 | 1 | 0 | 0 | 13.6% | 100.0% |
| Dialogue history QA | 19 | 11 | 1 | 0 | 0 | 57.9% | 100.0% |
| Event ordering | 18 | 16 | 1 | 0 | 2 | 88.9% | 90.0% |
| Financial | 33 | 16 | 0 | 4 | 4 | 48.5% | 89.2% |
| Governmental | 33 | 16 | 0 | 1 | 8 | 48.5% | 80.5% |
| Knowledge graph reasoning | 11 | 7 | 1 | 0 | 4 | 63.6% | 73.3% |
| Legal | 32 | 17 | 0 | 0 | 1 | 53.1% | 97.0% |
| Literary | 24 | 12 | 2 | 0 | 6 | 50.0% | 80.0% |
| Many-shot learning | 21 | 10 | 6 | 0 | 0 | 47.6% | 100.0% |
| Multi-news | 23 | 12 | 2 | 0 | 0 | 52.2% | 100.0% |
| New language translation | 0 | 0 | 0 | 0 | 20 | n/a | 0.0% |
| Table QA | 8 | 3 | 1 | 1 | 10 | 37.5% | 44.4% |
| User guide QA | 33 | 21 | 0 | 0 | 7 | 63.6% | 82.5% |

### Without the dev sample (30 runs of the 30 dev cases left out)

| runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 473 | 373 | 78.9% | 206 | 147 | 14 | 6 | 100 | 55.2% |

## lb2-direct-kimi

Model moonshotai/kimi-k2.5; overflow skip; context 262144 tokens, output 16384; reasoning {"enabled":true}; prompt 0shot.txt@c5ea10bcd06285223c58dfed76bbc92d22273709; harness version 1.

| selected | runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 503 | 503 | 400 | 79.5% | 245 | 135 | 10 | 10 | 103 | 61.3% |

### By difficulty

| difficulty | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| easy | 147 | 95 | 5 | 4 | 45 | 64.6% | 76.6% |
| hard | 253 | 150 | 5 | 6 | 58 | 59.3% | 81.4% |

### By length

| length | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| long | 18 | 7 | 0 | 5 | 90 | 38.9% | 16.7% |
| medium | 203 | 122 | 9 | 3 | 12 | 60.1% | 94.4% |
| short | 179 | 116 | 1 | 2 | 1 | 64.8% | 99.4% |

### By domain

| domain | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Code Repository Understanding | 18 | 12 | 0 | 0 | 32 | 66.7% | 36.0% |
| Long In-context Learning | 54 | 37 | 4 | 2 | 27 | 68.5% | 66.7% |
| Long Structured Data Understanding | 19 | 12 | 2 | 1 | 14 | 63.2% | 57.6% |
| Long-dialogue History Understanding | 39 | 30 | 0 | 0 | 0 | 76.9% | 100.0% |
| Multi-Document QA | 111 | 62 | 0 | 5 | 14 | 55.9% | 88.8% |
| Single-Document QA | 159 | 92 | 4 | 2 | 16 | 57.9% | 90.9% |

### By sub-domain

| sub-domain | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Academic | 85 | 52 | 1 | 0 | 9 | 61.2% | 90.4% |
| Agent history QA | 20 | 17 | 0 | 0 | 0 | 85.0% | 100.0% |
| Code repo QA | 18 | 12 | 0 | 0 | 32 | 66.7% | 36.0% |
| Detective | 22 | 8 | 1 | 0 | 0 | 36.4% | 100.0% |
| Dialogue history QA | 19 | 13 | 0 | 0 | 0 | 68.4% | 100.0% |
| Event ordering | 18 | 16 | 1 | 0 | 2 | 88.9% | 90.0% |
| Financial | 33 | 20 | 0 | 5 | 4 | 60.6% | 89.2% |
| Governmental | 33 | 13 | 0 | 1 | 8 | 39.4% | 80.5% |
| Knowledge graph reasoning | 11 | 10 | 1 | 0 | 4 | 90.9% | 73.3% |
| Legal | 32 | 22 | 0 | 0 | 1 | 68.8% | 97.0% |
| Literary | 24 | 12 | 1 | 0 | 6 | 50.0% | 80.0% |
| Many-shot learning | 21 | 15 | 4 | 1 | 0 | 71.4% | 100.0% |
| Multi-news | 23 | 11 | 0 | 1 | 0 | 47.8% | 100.0% |
| New language translation | 0 | 0 | 0 | 0 | 20 | n/a | 0.0% |
| Table QA | 8 | 2 | 1 | 1 | 10 | 25.0% | 44.4% |
| User guide QA | 33 | 22 | 0 | 1 | 7 | 66.7% | 82.5% |

### Without the dev sample (30 runs of the 30 dev cases left out)

| runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 473 | 373 | 78.9% | 230 | 123 | 10 | 10 | 100 | 61.7% |

## lb2-custom

Model qwen/qwen3.6-35b-a3b; overflow n/a; context 262144 tokens, output 16384; reasoning {"enabled":true}; prompt 0shot.txt@c5ea10bcd06285223c58dfed76bbc92d22273709+custom/10; harness version 10.

| selected | runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 503 | 503 | 503 | 100.0% | 280 | 199 | 13 | 11 | 0 | 55.7% |

### By difficulty

| difficulty | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| easy | 192 | 121 | 4 | 4 | 0 | 63.0% | 100.0% |
| hard | 311 | 159 | 9 | 7 | 0 | 51.1% | 100.0% |

### By length

| length | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| long | 108 | 49 | 2 | 7 | 0 | 45.4% | 100.0% |
| medium | 215 | 119 | 8 | 4 | 0 | 55.3% | 100.0% |
| short | 180 | 112 | 3 | 0 | 0 | 62.2% | 100.0% |

### By domain

| domain | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Code Repository Understanding | 50 | 30 | 1 | 0 | 0 | 60.0% | 100.0% |
| Long In-context Learning | 81 | 44 | 6 | 0 | 0 | 54.3% | 100.0% |
| Long Structured Data Understanding | 33 | 19 | 2 | 4 | 0 | 57.6% | 100.0% |
| Long-dialogue History Understanding | 39 | 25 | 2 | 0 | 0 | 64.1% | 100.0% |
| Multi-Document QA | 125 | 64 | 1 | 3 | 0 | 51.2% | 100.0% |
| Single-Document QA | 175 | 98 | 1 | 4 | 0 | 56.0% | 100.0% |

### By sub-domain

| sub-domain | n eligible | correct | invalid | failed | unsupported | accuracy | coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Academic | 94 | 51 | 1 | 1 | 0 | 54.3% | 100.0% |
| Agent history QA | 20 | 15 | 1 | 0 | 0 | 75.0% | 100.0% |
| Code repo QA | 50 | 30 | 1 | 0 | 0 | 60.0% | 100.0% |
| Detective | 22 | 6 | 0 | 0 | 0 | 27.3% | 100.0% |
| Dialogue history QA | 19 | 10 | 1 | 0 | 0 | 52.6% | 100.0% |
| Event ordering | 20 | 16 | 0 | 3 | 0 | 80.0% | 100.0% |
| Financial | 37 | 24 | 0 | 3 | 0 | 64.9% | 100.0% |
| Governmental | 41 | 17 | 0 | 0 | 0 | 41.5% | 100.0% |
| Knowledge graph reasoning | 15 | 10 | 0 | 3 | 0 | 66.7% | 100.0% |
| Legal | 33 | 22 | 0 | 0 | 0 | 66.7% | 100.0% |
| Literary | 30 | 13 | 1 | 0 | 0 | 43.3% | 100.0% |
| Many-shot learning | 21 | 9 | 6 | 0 | 0 | 42.9% | 100.0% |
| Multi-news | 23 | 13 | 0 | 0 | 0 | 56.5% | 100.0% |
| New language translation | 20 | 13 | 0 | 0 | 0 | 65.0% | 100.0% |
| Table QA | 18 | 9 | 2 | 1 | 0 | 50.0% | 100.0% |
| User guide QA | 40 | 22 | 0 | 0 | 0 | 55.0% | 100.0% |

### Without the dev sample (30 runs of the 30 dev cases left out)

| runs | eligible | coverage | correct | incorrect | invalid | failed | unsupported | accuracy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 473 | 473 | 100.0% | 268 | 183 | 11 | 11 | 0 | 56.7% |

