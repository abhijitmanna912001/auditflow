"""Tests for POST /send-to-zoho-desk. A fake ZohoClient is injected through
api.get_zoho_client: no Zoho or model API call is made."""

import hashlib
import hmac
import json
import logging
import sys
import threading
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from connectors.zoho_desk import ZohoError, ZohoRateLimitError  # noqa: E402
from orchestration import api  # noqa: E402

PEPPER = "test-pepper-not-a-secret"
CODE = "AF-alice-test-code"
TOKEN = "tok-SECRET-should-never-appear"
COMPANY = "Zebra Holdings Ltd"
FID = "AF-0123456789"
FID2 = "AF-abcdef0123-2"
EXPLANATION = "unique-explanation-text-xyz"
PDF_NAME = "secret-invoice-name.pdf"


def _hash(code):
    return hmac.new(PEPPER.encode(), code.encode(), hashlib.sha256).hexdigest()


class FakeScan:
    def __init__(self, tickets, cap):
        self.tickets, self.scan_limit_reached = tickets, cap

    def __iter__(self):
        yield list(self.tickets)


class FakeZoho:
    def __init__(self, scan_cap=False, fail_attach=(), create_delay=0.0, create_error=None):
        self.tickets = []
        self.scan_cap = scan_cap
        self.fail_attach = set(fail_attach)
        self.create_delay = create_delay
        self.create_error = create_error
        self.attached = []
        self.comments = []
        self.lock = threading.Lock()

    def find_or_create_account(self, name):
        return {"id": "acc1", "name": name, "created": False}

    def find_or_create_contact(self, account_id, company):
        return {"id": "con1", "created": False}

    def list_account_tickets(self, account_id):
        with self.lock:
            return FakeScan(list(self.tickets), self.scan_cap)

    def create_ticket(self, subject, description_html, contact_id, department_id=None):
        if self.create_error:
            raise self.create_error
        time.sleep(self.create_delay)
        with self.lock:
            n = len(self.tickets) + 1
            self.tickets.append({
                "id": f"t{n}", "subject": subject, "ticketNumber": str(100 + n),
                "webUrl": f"https://desk.example/t{n}", "description": description_html,
            })
            return {"ticket_number": str(100 + n), "id": f"t{n}", "web_url": f"https://desk.example/t{n}"}

    def attach_file(self, ticket_id, filename, content_bytes):
        if filename in self.fail_attach:
            raise ZohoError("HTTP 500")
        self.attached.append((ticket_id, filename, len(content_bytes)))

    def add_private_comment(self, ticket_id, text):
        self.comments.append((ticket_id, text))


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    for name in ("AUDITFLOW_ACCESS_CODES", "AUDITFLOW_CODE_PEPPER"):
        monkeypatch.delenv(name, raising=False)
    yield
    monkeypatch.delenv("AUDITFLOW_ACCESS_CODES", raising=False)
    monkeypatch.delenv("AUDITFLOW_CODE_PEPPER", raising=False)
    api._init_access_control()


@pytest.fixture
def setup(monkeypatch):
    def _setup(fake=None, access=True, **alice):
        cfg = {"hash": _hash(CODE), "daily_runs": 3, "daily_tickets": 50, "max_files": 3,
               "max_file_mb": 20, "resolver": False, **alice}
        if access:
            monkeypatch.setenv("AUDITFLOW_ACCESS_CODES", json.dumps({"alice": cfg}))
            monkeypatch.setenv("AUDITFLOW_CODE_PEPPER", PEPPER)
        api._init_access_control()
        fake = fake or FakeZoho()
        monkeypatch.setattr(api, "get_zoho_client", lambda: fake)
        return fake
    return _setup


def finding(fid=FID, **over):
    f = {"finding_id": fid, "type": "duplicate", "label": "Vendor mismatch",
         "explanation": EXPLANATION, "primary_document": "INV-1",
         "documents": ["INV-1", "PO-1"], "transaction_documents": []}
    f.update(over)
    return f


DOC_MAP = [{"doc_id": "INV-1", "source_file": PDF_NAME}, {"doc_id": "PO-1", "source_file": "po.pdf"}]


def send(code=CODE, fnd=None, company=COMPANY, files=None, doc_map=DOC_MAP, ambiguous=(), raw=None):
    fields = {"company": company, "finding": json.dumps(fnd or finding()),
              "documents_map": json.dumps(doc_map), "ambiguous_doc_ids": json.dumps(list(ambiguous))}
    fields.update(raw or {})
    if files is None:
        files = [(PDF_NAME, b"a" * 10), ("po.pdf", b"b" * 20)]
    parts = [("files", (n, d, "application/pdf")) for n, d in files]
    headers = {"X-Access-Code": code} if code else {}
    return TestClient(api.app).post("/send-to-zoho-desk", data=fields, files=parts or None, headers=headers)


# ---- gates -----------------------------------------------------------------


def test_access_control_off_is_503(setup):
    setup(access=False)
    r = send(code=None)
    assert r.status_code == 503 and "needs access control to be on" in r.json()["detail"]


def test_no_code_and_wrong_code_are_401(setup):
    fake = setup()
    assert send(code=None).status_code == 401
    assert send(code="AF-wrong").status_code == 401
    assert fake.tickets == []


def test_zoho_not_configured_503_names_no_setting(setup, monkeypatch):
    setup()
    for n in ("ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID", "ZOHO_DEPARTMENT_ID"):
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setattr(api, "_zoho_client", None)
    monkeypatch.setattr(api, "get_zoho_client", _REAL_FACTORY)  # the real, lazy factory
    r = send()
    assert r.status_code == 503
    assert "ZOHO" not in r.text


_REAL_FACTORY = api.get_zoho_client


def test_file_count_and_size_limits(setup):
    setup(max_files=1, max_file_mb=1)
    assert send(files=[("a.pdf", b"x"), ("b.pdf", b"y")]).status_code == 400
    assert send(files=[("a.pdf", b"x" * (1024 * 1024 + 1))]).status_code == 413


# ---- validation ------------------------------------------------------------


@pytest.mark.parametrize("kwargs", [
    {"fnd": finding(fid="AF-123")},
    {"fnd": finding(fid="AF-0123456789\n")},
    {"raw": {"finding": "{not json"}},
    {"raw": {"documents_map": "nope"}},
    {"raw": {"ambiguous_doc_ids": "nope"}},
    {"company": "   "},
    {"company": "x" * 121},
    {"fnd": finding(explanation="x" * 4001)},
    {"fnd": finding(documents=["d"] * 31)},
    {"fnd": finding(documents=["d" * 121])},
])
def test_bad_input_is_400(setup, kwargs):
    fake = setup()
    assert send(**kwargs).status_code == 400
    assert fake.tickets == []


def test_too_many_files_is_400(setup):
    setup(max_files=2)
    assert send(files=[(f"{i}.pdf", b"x") for i in range(3)]).status_code == 400


# ---- flow ------------------------------------------------------------------


def test_happy_path_creates_one_ticket_and_attaches(setup):
    fake = setup()
    r = send()
    body = r.json()
    assert r.status_code == 200 and body["outcome"] == "created"
    assert body["ticket_number"] == "101" and body["finding_id"] == FID
    assert body["account"] == {"id": "acc1", "name": COMPANY, "created": False}
    assert body["attachments"]["attached"] == [PDF_NAME, "po.pdf"]
    assert body["attachments"]["failed"] == []
    assert len(fake.tickets) == 1 and fake.tickets[0]["subject"].startswith(f"[{FID}] ")
    assert [a[1] for a in fake.attached] == [PDF_NAME, "po.pdf"]
    assert fake.comments == []


def test_only_cited_files_are_attached(setup):
    fake = setup()
    send(fnd=finding(documents=["INV-1"]), files=[(PDF_NAME, b"a"), ("other.pdf", b"b")])
    assert [a[1] for a in fake.attached] == [PDF_NAME]


def test_duplicate_returns_existing_and_creates_none(setup):
    fake = setup()
    fake.tickets.append({"id": "t9", "subject": f"[{FID}] old", "ticketNumber": "77", "webUrl": "https://desk.example/t9"})
    body = send().json()
    assert body["outcome"] == "duplicate" and body["ticket_number"] == "77"
    assert body["web_url"] == "https://desk.example/t9"
    assert len(fake.tickets) == 1 and fake.attached == []


def test_scan_cap_is_unconfirmed_and_creates_nothing(setup):
    fake = setup(FakeZoho(scan_cap=True))
    body = send().json()
    assert body["outcome"] == "unconfirmed" and body["ticket_number"] is None
    assert fake.tickets == []


def test_attachment_failure_keeps_ticket_and_adds_private_note(setup):
    fake = setup(FakeZoho(fail_attach={"po.pdf"}))
    body = send().json()
    assert body["outcome"] == "created"
    assert body["attachments"]["attached"] == [PDF_NAME]
    assert body["attachments"]["failed"] == ["po.pdf"]
    assert len(fake.comments) == 1
    assert fake.comments[0][1].startswith("AuditFlow note: ")
    assert "po.pdf" in fake.comments[0][1]


def test_file_over_size_limit_is_skipped_and_named(setup):
    fake = setup()
    big = b"x" * 19_000_001
    body = send(files=[(PDF_NAME, big), ("po.pdf", b"b")]).json()
    assert body["outcome"] == "created"
    assert [x["filename"] for x in body["attachments"]["not_attached_size"]] == [PDF_NAME]
    assert body["attachments"]["attached"] == ["po.pdf"]
    assert fake.comments and fake.comments[0][1].startswith("AuditFlow note: ")
    assert PDF_NAME in fake.comments[0][1]


def test_missing_file_is_listed_and_noted(setup):
    fake = setup()
    body = send(files=[(PDF_NAME, b"a")]).json()
    assert [x["doc_id"] for x in body["attachments"]["no_file"]] == ["PO-1"]
    assert fake.comments[0][1].startswith("AuditFlow note: ")


# ---- quota -----------------------------------------------------------------


def test_daily_tickets_exhausted_is_429_and_duplicate_does_not_consume(setup):
    fake = setup(daily_tickets=1)
    assert send().json()["outcome"] == "created"
    assert send().json()["outcome"] == "duplicate"  # no quota spent, still answered
    r = send(fnd=finding(fid=FID2))
    assert r.status_code == 429 and "limit" in r.json()["detail"].lower()
    assert len(fake.tickets) == 1


def test_unconfirmed_and_failures_do_not_consume_quota(setup):
    setup(FakeZoho(scan_cap=True), daily_tickets=1)
    assert send().json()["outcome"] == "unconfirmed"
    fake = setup(FakeZoho(create_error=ZohoError("HTTP 500")), daily_tickets=1)
    assert send().status_code == 502
    fake.create_error = None
    assert send().json()["outcome"] == "created"


def test_does_not_spend_daily_runs(setup):
    setup(daily_runs=1)
    send()
    assert api._client_runs.get("alice", 0) == 0


def test_daily_tickets_default_and_validation(monkeypatch):
    parsed = api._parse_access_codes(json.dumps({"c": {"hash": "ab"}}))
    assert parsed["c"]["daily_tickets"] == 50
    with pytest.raises(RuntimeError):
        api._parse_access_codes(json.dumps({"c": {"hash": "ab", "daily_tickets": -1}}))


# ---- errors ----------------------------------------------------------------


def test_zoho_failure_is_502_and_rate_limit_is_503(setup):
    fake = setup(FakeZoho(create_error=ZohoError("HTTP 500 " + TOKEN)))
    r = send()
    assert r.status_code == 502 and TOKEN not in r.text
    fake.create_error = ZohoRateLimitError("HTTP 429")
    r = send()
    assert r.status_code == 503 and r.json()["detail"] == "Zoho Desk is busy, please try again"


# ---- concurrency -----------------------------------------------------------


def test_two_simultaneous_requests_create_one_ticket(setup):
    fake = setup(FakeZoho(create_delay=0.3))
    results = []

    def go():
        results.append(send().json()["outcome"])

    threads = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["created", "duplicate"]
    assert len(fake.tickets) == 1


# ---- logging and secrets ---------------------------------------------------


def test_log_has_no_company_filename_text_or_token(setup, caplog):
    setup(FakeZoho(fail_attach={"po.pdf"}))
    with caplog.at_level(logging.DEBUG):
        r = send()
    assert r.status_code == 200
    lines = [rec.getMessage() for rec in caplog.records if rec.getMessage().startswith("zoho ")]
    assert lines == ["zoho client=alice outcome=created finding=%s ticket=101" % FID]
    text = caplog.text
    for secret in (COMPANY, "Zebra", PDF_NAME, "po.pdf", EXPLANATION, TOKEN, CODE):
        assert secret not in text
    assert TOKEN not in r.text
