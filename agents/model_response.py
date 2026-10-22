"""Clear errors for a model response that cannot be used.

Every agent reads its answer from the first text block of the response and
parses it as JSON. A response with no text block (a refusal, or an answer
cut off inside a thinking block) used to raise a bare StopIteration with an
empty message, and a response cut off at max_tokens failed later inside
json.loads. parse_json_response() turns each of those into a
ModelResponseError that names the agent and the cause.

How orchestration/api.py treats pipeline exceptions (kept exactly as it is):
POST /run-case turns any Exception into HTTP 500 with detail=str(exc);
POST /run-case-upload first catches ValueError and returns HTTP 400
("rejected"), then any other Exception as HTTP 500. The old failures were a
StopIteration (500) and a json.JSONDecodeError, which is a ValueError (400 on
upload). The two classes below keep those status codes:

- ModelResponseError (not a ValueError): refusal, no_text.   -> 500 on both
- ModelResponseFormatError (also a ValueError): truncated, parse. -> as before
  (500 on /run-case, 400 on /run-case-upload)

Messages never contain document text or the model's output.
"""

from __future__ import annotations

import json

# stop_reason values that mean the answer is incomplete.
_TRUNCATED_STOP_REASONS = ("max_tokens", "model_context_window_exceeded")


class ModelResponseError(Exception):
    """The model response has no usable answer. `cause` is one of
    refusal, no_text, truncated, parse."""

    def __init__(self, agent: str, cause: str, model: str | None = None, stop_reason: str | None = None):
        self.agent = agent
        self.cause = cause
        self.model = model
        self.stop_reason = stop_reason
        detail = f" (stop_reason: {stop_reason})" if stop_reason else ""
        super().__init__(f"{agent} agent: model response unusable, {cause}{detail}")


class ModelResponseFormatError(ModelResponseError, ValueError):
    """Truncated or unparseable output. A ValueError on purpose: the
    json.JSONDecodeError it replaces was one, and the upload endpoint maps
    ValueError to 400."""


def parse_json_response(response, agent: str, model: str | None = None) -> dict:
    """Return the JSON object in the response's first text block, or raise
    ModelResponseError / ModelResponseFormatError with a cause."""
    stop_reason = getattr(response, "stop_reason", None)

    if stop_reason == "refusal":
        raise ModelResponseError(agent, "refusal", model, stop_reason)

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        if stop_reason in _TRUNCATED_STOP_REASONS:
            raise ModelResponseFormatError(agent, "truncated", model, stop_reason)
        raise ModelResponseError(agent, "no_text", model, stop_reason)

    if stop_reason in _TRUNCATED_STOP_REASONS:
        raise ModelResponseFormatError(agent, "truncated", model, stop_reason)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # No `from`: the original error message quotes the model's text.
        raise ModelResponseFormatError(agent, "parse", model, stop_reason) from None
