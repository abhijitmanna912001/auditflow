"""Hand-edited price table and a cost estimate from token counts.

USD per million tokens. Every number below was read on 2026-10-22 from
    PRICING = https://platform.claude.com/docs/en/about-claude/pricing
(base input and output for the three 5.5 models also match
https://platform.claude.com/docs/en/models/overview). Edit this file by hand
when Anthropic changes a price, and update CHECKED_ON. The model names in
PRICES are also the only model names model_config accepts.

Usage fields (SDK response.usage): `input_tokens` is the uncached input,
`cache_read_input_tokens` and `cache_creation_input_tokens` are billed
separately; the prompt size that picks Haiku 5.5's price band counts all
three (the pricing page: "A request's prompt length counts all of its input
tokens, including cache reads and cache writes").
"""

from __future__ import annotations

from dataclasses import dataclass

CHECKED_ON = "2026-10-22"
SOURCE_URL = "https://platform.claude.com/docs/en/about-claude/pricing"

# Haiku 5.5 charges more for a request whose prompt is over this many tokens.
HAIKU_LONG_PROMPT_THRESHOLD = 100_000


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    cache_read: float
    cache_write_5m: float
    cache_write_1h: float


@dataclass(frozen=True)
class ModelPrice:
    """`long` is the band for prompts over `long_prompt_threshold` tokens
    (only Haiku 5.5 has one); None means one price for every size."""

    standard: Price
    long: Price | None = None
    long_prompt_threshold: int | None = None


PRICES: dict[str, ModelPrice] = {
    # PRICING: Claude Sonnet 5.5: $2 in, $2.50 5m write, $4 1h write,
    # $0.10 cache hit (0.05x input, footnote 2), $10 out.
    "claude-sonnet-5-5": ModelPrice(Price(2.00, 10.00, 0.10, 2.50, 4.00)),
    # PRICING: Claude Opus 5.5: $4 in, $5 5m write, $8 1h write,
    # $0.20 cache hit (0.05x input, footnote 2), $20 out.
    "claude-opus-5-5": ModelPrice(Price(4.00, 20.00, 0.20, 5.00, 8.00)),
    # PRICING: Claude Haiku 5.5, prompts up to 100,000 tokens: $0.10 in,
    # $0.125 5m write, $0.20 1h write, $0.01 cache hit, $0.50 out.
    # PRICING: Claude Haiku 5.5, prompts over 100,000 tokens: $0.50 in,
    # $0.625 5m write, $1 1h write, $0.05 cache hit, $2.50 out.
    "claude-haiku-5-5": ModelPrice(
        Price(0.10, 0.50, 0.01, 0.125, 0.20),
        long=Price(0.50, 2.50, 0.05, 0.625, 1.00),
        long_prompt_threshold=HAIKU_LONG_PROMPT_THRESHOLD,
    ),
    # PRICING: Claude Sonnet 5: $2 in, $2.50 5m write, $4 1h write,
    # $0.20 cache hit, $10 out (footnote 3: $2/$10 is now the standard price).
    "claude-sonnet-5": ModelPrice(Price(2.00, 10.00, 0.20, 2.50, 4.00)),
    # PRICING: Claude Opus 5: $5 in, $6.25 5m write, $10 1h write,
    # $0.50 cache hit, $25 out.
    "claude-opus-5": ModelPrice(Price(5.00, 25.00, 0.50, 6.25, 10.00)),
}


def known_models() -> list[str]:
    return sorted(PRICES)


def price_for(model: str, prompt_tokens: int = 0) -> Price:
    """The Price that applies to one request of `model` whose whole prompt
    (uncached + cache reads + cache writes) is `prompt_tokens` tokens."""
    try:
        entry = PRICES[model]
    except KeyError:
        raise KeyError(f"No price for model {model!r}; add it to agents/price_table.py") from None
    if entry.long is not None and prompt_tokens > entry.long_prompt_threshold:
        return entry.long
    return entry.standard


def estimate_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    cache_write_1h_tokens: int = 0,
) -> float:
    """Estimated dollars for ONE request. `cache_write_tokens` are 5-minute
    cache writes; `cache_write_1h_tokens` the 1-hour kind (none are used by
    AuditFlow today). Output includes any thinking tokens."""
    prompt_tokens = input_tokens + cache_read_tokens + cache_write_tokens + cache_write_1h_tokens
    p = price_for(model, prompt_tokens)
    return (
        input_tokens * p.input
        + output_tokens * p.output
        + cache_read_tokens * p.cache_read
        + cache_write_tokens * p.cache_write_5m
        + cache_write_1h_tokens * p.cache_write_1h
    ) / 1_000_000
