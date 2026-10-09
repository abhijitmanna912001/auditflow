"""Tests for the Zoho Desk client against a fake HTTP transport."""

import json
import threading

import pytest

from connectors.zoho_desk import (
    HttpResponse,
    RefreshTokenProvider,
    ZohoAuthError,
    ZohoClient,
    ZohoError,
    ZohoRateLimitError,
    ZohoScanCapReached,
)

SECRET = "s3cret-value"
REFRESH = "r3fresh-value"


def resp(status=200, body=None, headers=None):
    raw = b"" if body is None else json.dumps(body).encode()
    return HttpResponse(status, headers or {}, raw)


class FakeTransport:
    """Scripted responses (a list, or a callable), recording every call."""

    def __init__(self, script):
        self.script = script
        self.calls = []
        self._lock = threading.Lock()

    def request(
        self, method, url, headers=None, params=None, json=None, files=None, data=None, timeout=None
    ):
        with self._lock:
            self.calls.append(
                dict(
                    method=method, url=url, headers=headers, params=params, json=json,
                    files=files, data=data, timeout=timeout,
                )
            )
            if callable(self.script):
                return self.script(self.calls[-1])
            return self.script.pop(0)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def token_resp(token="tok1", expires=3600):
    return resp(200, {"access_token": token, "expires_in": expires})


def provider(script, clock=None):
    t = FakeTransport(script)
    return RefreshTokenProvider("cid", SECRET, REFRESH, "https://accounts.zoho.in", t, clock or Clock()), t


class StaticTokens:
    def __init__(self):
        self.n = 0
        self.invalidated = []

    def get_token(self):
        self.n += 1
        return f"t{self.n}"

    def invalidate(self, stale=None):
        self.invalidated.append(stale)


def client(script, **kw):
    sleeps = []
    t = FakeTransport(script)
    c = ZohoClient(
        kw.pop("tokens", StaticTokens()),
        "org1",
        "https://desk.zoho.in",
        "dept1",
        transport=t,
        sleep=sleeps.append,
        **kw,
    )
    return c, t, sleeps


# ---- token provider ----------------------------------------------------------


def test_token_cached_then_refreshed_early():
    clock = Clock()
    p, t = provider([token_resp("a", 3600), token_resp("b", 3600)], clock)
    assert p.get_token() == "a"
    clock.now += 3600 - 61
    assert p.get_token() == "a"
    assert len(t.calls) == 1
    clock.now += 2  # inside the last 60 s
    assert p.get_token() == "b"
    assert len(t.calls) == 2
    # secrets travel in the form body, not the URL
    assert SECRET not in t.calls[0]["url"] and t.calls[0]["data"]["client_secret"] == SECRET
    assert t.calls[0]["url"].endswith("/oauth/v2/token")


def test_token_error_has_no_secret():
    body = {"error": "invalid_code", "client_secret": SECRET, "refresh_token": REFRESH}
    p, _ = provider([resp(400, body)])
    with pytest.raises(ZohoAuthError) as exc:
        p.get_token()
    text = str(exc.value) + repr(exc.value)
    assert "400" in text and "invalid_code" in text
    assert SECRET not in text and REFRESH not in text


def test_401_refreshes_once_and_retries():
    p, pt = provider([token_resp("old"), token_resp("new")])
    c, t, _ = client(
        [resp(401, {"errorCode": "INVALID_OAUTH"}), resp(200, {"id": "1", "ticketNumber": "5", "webUrl": "u"})],
        tokens=p,
    )
    out = c.create_ticket("s", "<p>d</p>", "c1")
    assert out == {"ticket_number": "5", "id": "1", "web_url": "u"}
    assert [x["headers"]["Authorization"] for x in t.calls] == [
        "Zoho-oauthtoken old",
        "Zoho-oauthtoken new",
    ]
    assert len(pt.calls) == 2


def test_second_401_raises_without_token():
    p, _ = provider([token_resp("old"), token_resp("new")])
    c, _, _ = client([resp(401, {"errorCode": "INVALID_OAUTH", "message": "bad"})] * 2, tokens=p)
    with pytest.raises(ZohoError) as exc:
        c.add_private_comment("1", "x")
    assert "401" in str(exc.value) and "INVALID_OAUTH" in str(exc.value)
    assert "old" not in str(exc.value) and "new" not in str(exc.value)


# ---- accounts and contacts -------------------------------------------------------


def paged(items, key):
    """Fake list endpoint over `items` honouring from/limit."""

    def handler(call):
        p = call["params"]
        start, limit = p["from"], p["limit"]
        chunk = items[start - 1 : start - 1 + limit]
        return resp(200, {"data": chunk}) if chunk else resp(204)

    return handler


def test_account_found_on_later_page_case_insensitively():
    accounts = [{"id": str(i), "accountName": f"Other {i}"} for i in range(250)]
    accounts[230] = {"id": "target", "accountName": "ACME   ltd"}
    c, t, _ = client(paged(accounts, "accounts"))
    out = c.find_or_create_account("  acme LTD ")
    assert out == {"id": "target", "name": "ACME   ltd", "created": False}
    assert [x["params"]["from"] for x in t.calls] == [1, 101, 201]
    assert all(x["params"]["limit"] == 100 for x in t.calls)
    assert all(x["method"] == "GET" for x in t.calls)


def test_account_created_when_absent():
    def handler(call):
        if call["method"] == "POST":
            assert call["json"] == {"accountName": "New Co"}
            return resp(200, {"id": "n1"})
        return resp(204)

    c, _, _ = client(handler)
    assert c.find_or_create_account("New  Co") == {"id": "n1", "name": "New Co", "created": True}


def test_account_no_duplicate_under_two_threads():
    store = []
    gate = threading.Event()

    def handler(call):
        if call["method"] == "POST":
            store.append({"id": "n1", "accountName": call["json"]["accountName"]})
            return resp(200, {"id": "n1"})
        gate.wait(0.2)  # widen the race window
        return resp(200, {"data": list(store)}) if store else resp(204)

    c, t, _ = client(handler)
    results = []
    threads = [
        threading.Thread(target=lambda n=n: results.append(c.find_or_create_account(n)))
        for n in ("Race Co", "race  co")
    ]
    [th.start() for th in threads]
    [th.join() for th in threads]
    assert len(store) == 1
    assert sorted(r["created"] for r in results) == [False, True]
    assert sum(1 for x in t.calls if x["method"] == "POST") == 1


def test_account_scan_cap_refuses_to_create():
    accounts = [{"id": str(i), "accountName": f"A{i}"} for i in range(2500)]
    c, t, _ = client(paged(accounts, "accounts"))
    with pytest.raises(ZohoScanCapReached):
        c.find_or_create_account("Not There")
    assert len(t.calls) == 20
    assert not any(x["method"] == "POST" for x in t.calls)


def test_contact_found_over_pages():
    contacts = [{"id": str(i), "lastName": f"L{i}"} for i in range(150)]
    contacts[120] = {"id": "fixed", "lastName": "auditflow FINDINGS"}
    c, t, _ = client(paged(contacts, "contacts"))
    assert c.find_or_create_contact("acc1", "Acme") == {"id": "fixed", "created": False}
    assert t.calls[0]["url"].endswith("/accounts/acc1/contacts")


def test_contact_created_with_slug_and_domain():
    def handler(call):
        if call["method"] == "POST":
            return resp(200, {"id": "c9"})
        return resp(204)

    c, t, _ = client(handler, contact_email_domain="audit.test")
    assert c.find_or_create_contact("acc1", "Acme & Sons, Ltd.") == {"id": "c9", "created": True}
    post = t.calls[-1]
    assert post["json"] == {
        "lastName": "AuditFlow findings",
        "email": "auditflow+acme-sons-ltd@audit.test",
        "accountId": "acc1",
    }


def test_default_contact_domain():
    c, t, _ = client(lambda call: resp(200, {"id": "c"}) if call["method"] == "POST" else resp(204))
    c.find_or_create_contact("a", "X")
    assert t.calls[-1]["json"]["email"] == "auditflow+x@example.com"


# ---- tickets ------------------------------------------------------------------------


def test_ticket_scan_pages_and_end():
    tickets = [{"subject": f"s{i}"} for i in range(230)]
    c, t, _ = client(paged(tickets, "t"))
    scan = c.list_account_tickets("acc1")
    pages = list(scan)
    assert [len(p) for p in pages] == [100, 100, 30]
    assert scan.pages_scanned == 3 and scan.scan_limit_reached is False


def test_ticket_scan_cap_reached():
    tickets = [{"subject": f"s{i}"} for i in range(5000)]
    c, t, _ = client(paged(tickets, "t"))
    scan = c.list_account_tickets("acc1")
    assert sum(len(p) for p in scan) == 2000
    assert scan.pages_scanned == 20 and scan.scan_limit_reached is True
    assert len(t.calls) == 20


def test_ticket_scan_empty_204():
    c, _, _ = client([resp(204)])
    scan = c.list_account_tickets("acc1")
    assert list(scan) == []
    assert scan.scan_limit_reached is False and scan.pages_scanned == 0


def test_create_ticket_payload():
    c, t, _ = client([resp(200, {"id": "9", "ticketNumber": "12", "webUrl": "https://w/9"})])
    out = c.create_ticket("subj", "<p>x</p>", "con1", "depX")
    assert out == {"ticket_number": "12", "id": "9", "web_url": "https://w/9"}
    call = t.calls[0]
    assert call["json"] == {
        "subject": "subj",
        "description": "<p>x</p>",
        "contactId": "con1",
        "departmentId": "depX",
        "channel": "Web",
    }
    assert call["headers"]["orgId"] == "org1"
    assert call["url"] == "https://desk.zoho.in/api/v1/tickets"


def test_attach_file_one_private_file():
    c, t, _ = client([resp(200, {"id": "a1"})])
    c.attach_file("77", "inv.pdf", b"bytes")
    call = t.calls[0]
    assert call["url"].endswith("/tickets/77/attachments")
    assert call["files"]["file"] == ("inv.pdf", b"bytes")
    assert call["files"]["isPublic"] == (None, "false")


def test_only_attach_file_uses_the_long_timeout():
    c, t, _ = client(lambda call: resp(200, {"data": [], "id": "x"}))
    c.attach_file("77", "inv.pdf", b"bytes")
    c.add_private_comment("77", "note")
    c.create_ticket("s", "<p>d</p>", "c1")
    c.find_or_create_contact("a1", "Acme")
    list(c.list_account_tickets("a1"))
    by_path = {(x["method"], x["url"].rsplit("/api/v1", 1)[1]): x["timeout"] for x in t.calls}
    assert by_path[("POST", "/tickets/77/attachments")] == 120
    others = [x["timeout"] for x in t.calls if not x["url"].endswith("/attachments")]
    assert others and all(v == 30 for v in others)


def test_requests_transport_per_call_timeout(monkeypatch):
    import requests

    from connectors.zoho_desk import RequestsTransport

    seen = []

    class R:
        status_code = 200
        headers = {}
        content = b"{}"

    monkeypatch.setattr(requests, "request", lambda *a, **kw: seen.append(kw["timeout"]) or R())
    tr = RequestsTransport()
    tr.request("GET", "https://x")
    tr.request("POST", "https://x", timeout=120)
    assert seen == [30, 120]


def test_private_comment():
    c, t, _ = client([resp(200, {"id": "c1"})])
    c.add_private_comment("77", "could not attach x.pdf")
    assert t.calls[0]["json"] == {"content": "could not attach x.pdf", "isPublic": False}


def test_204_empty_body_ok():
    c, _, _ = client([resp(204)])
    assert c.add_private_comment("1", "x") is None


# ---- rate limits --------------------------------------------------------------------


def test_429_retries_twice_then_succeeds():
    c, t, sleeps = client([resp(429), resp(429), resp(200, {"id": "1"})])
    c.add_private_comment("1", "x")
    assert len(t.calls) == 3 and len(sleeps) == 2


def test_429_three_times_fails_clearly():
    c, t, _ = client([resp(429, {"message": "slow down"})] * 3)
    with pytest.raises(ZohoRateLimitError) as exc:
        c.add_private_comment("1", "document text here")
    assert "429" in str(exc.value) and "document text" not in str(exc.value)
    assert len(t.calls) == 3


def test_error_message_has_status_code_and_message_only():
    c, _, _ = client([resp(422, {"errorCode": "UNPROCESSABLE_ENTITY", "message": "bad field"})])
    with pytest.raises(ZohoError) as exc:
        c.create_ticket("SECRET SUBJECT", "SECRET BODY", "c")
    text = str(exc.value)
    assert "422" in text and "UNPROCESSABLE_ENTITY" in text and "bad field" in text
    assert "SECRET" not in text and exc.value.status == 422


def test_low_rate_limit_sleeps():
    c, _, sleeps = client(
        [resp(200, {"id": "1"}, {"X-Rate-Limit-Remaining-V3": "10"})],
        low_rate_threshold=30,
        low_rate_sleep=1.5,
    )
    c.add_private_comment("1", "x")
    assert sleeps == [1.5] and c.rate_limit_remaining == 10


def test_healthy_rate_limit_does_not_sleep():
    c, _, sleeps = client(
        [resp(200, {"id": "1"}, {"x-rate-limit-remaining-v3": "4000"})], low_rate_threshold=30
    )
    c.add_private_comment("1", "x")
    assert sleeps == [] and c.rate_limit_remaining == 4000
