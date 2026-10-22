"""Tests for price_table with hand-computed examples (USD per million tokens)."""

import pytest

from model_config import DEFAULTS
from price_table import HAIKU_LONG_PROMPT_THRESHOLD, PRICES, estimate_cost, known_models, price_for


def test_sonnet_5_5_hand_computed():
    # 1,000,000 in x $2 + 100,000 out x $10/M = 2.00 + 1.00
    assert estimate_cost("claude-sonnet-5-5", 1_000_000, 100_000) == pytest.approx(3.00)


def test_opus_5_5_with_cache_hand_computed():
    # 50,000 x $4 + 2,000 x $20 + 200,000 read x $0.20 + 10,000 write x $5, per M
    expected = (50_000 * 4 + 2_000 * 20 + 200_000 * 0.20 + 10_000 * 5) / 1_000_000
    assert expected == pytest.approx(0.200 + 0.040 + 0.040 + 0.050)
    assert estimate_cost("claude-opus-5-5", 50_000, 2_000, 200_000, 10_000) == pytest.approx(0.33)


def test_one_hour_cache_write_uses_its_own_rate():
    # 1,000,000 x $4 (Sonnet 5.5, 1h write) = 4.00
    assert estimate_cost("claude-sonnet-5-5", 0, 0, cache_write_1h_tokens=1_000_000) == pytest.approx(4.00)


def test_haiku_5_5_up_to_100k_uses_the_lower_band():
    # exactly 100,000 prompt tokens is still the lower band: 100,000 x $0.10 + 1,000 x $0.50, per M
    assert estimate_cost("claude-haiku-5-5", 100_000, 1_000) == pytest.approx(0.0100 + 0.0005)


def test_haiku_5_5_above_100k_uses_the_higher_band():
    # 100,001 x $0.50 + 1,000 x $2.50, per M
    expected = (100_001 * 0.50 + 1_000 * 2.50) / 1_000_000
    assert estimate_cost("claude-haiku-5-5", 100_001, 1_000) == pytest.approx(expected)
    assert expected == pytest.approx(0.0525005)


def test_haiku_band_counts_cache_reads_and_writes_in_the_prompt_size():
    # 40,000 uncached + 60,000 read + 1,000 written = 101,000 > 100,000 -> higher band
    expected = (40_000 * 0.50 + 500 * 2.50 + 60_000 * 0.05 + 1_000 * 0.625) / 1_000_000
    assert estimate_cost("claude-haiku-5-5", 40_000, 500, 60_000, 1_000) == pytest.approx(expected)
    assert price_for("claude-haiku-5-5", HAIKU_LONG_PROMPT_THRESHOLD + 1).input == 0.50
    assert price_for("claude-haiku-5-5", HAIKU_LONG_PROMPT_THRESHOLD).input == 0.10


def test_other_models_have_one_band_at_any_size():
    for model in ("claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-opus-5"):
        assert price_for(model, 5_000_000) == price_for(model, 1)


def test_baseline_models_are_priced_and_listed():
    for settings in DEFAULTS.values():
        assert settings.model in PRICES
    assert known_models() == sorted(PRICES) and "claude-opus-5" in PRICES


def test_a_pipeline_sized_example():
    # Anomaly call on Opus 5: 3,000 in, 1,500 out = 0.015 + 0.0375
    assert estimate_cost("claude-opus-5", 3_000, 1_500) == pytest.approx(0.0525)


def test_unknown_model_is_an_error():
    with pytest.raises(KeyError):
        estimate_cost("claude-unknown", 1, 1)
