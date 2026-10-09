"""CORS preflight tests for orchestration/api.py. No model API calls."""

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from orchestration import api  # noqa: E402

client = TestClient(api.app)
ORIGIN = api.allowed_origins[0]


def _preflight(path, method, origin=ORIGIN, headers="x-access-code"):
    return client.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
        },
    )


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/feedback/history"),
        ("POST", "/run-case-upload"),
        ("POST", "/feedback"),
        ("POST", "/run-case"),
    ],
)
def test_preflight_allowed(method, path):
    resp = _preflight(path, method)
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == ORIGIN
    assert "x-access-code" in resp.headers["access-control-allow-headers"].lower()
    assert method in resp.headers["access-control-allow-methods"]


def test_preflight_disallowed_origin_refused():
    resp = _preflight("/feedback/history", "GET", origin="https://evil.example")
    assert resp.status_code == 400
    assert "access-control-allow-origin" not in resp.headers


def test_preflight_unlisted_header_refused():
    resp = _preflight("/feedback/history", "GET", headers="x-other")
    assert resp.status_code == 400


def test_preflight_delete_refused():
    resp = _preflight("/feedback/history", "DELETE")
    assert resp.status_code == 400
