"""Zoho Desk client. No FastAPI imports; HTTP goes through an injectable
transport so tests need no network."""

from __future__ import annotations

import json as jsonlib
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

try:  # allow both `connectors.x` and flat imports
    from connectors.ticket_content import normalise_company
except ImportError:  # pragma: no cover
    from ticket_content import normalise_company

DEFAULT_TIMEOUT = 30
UPLOAD_TIMEOUT = 120
PAGE_SIZE = 100
MAX_PAGES = 20
CONTACT_LAST_NAME = "AuditFlow findings"
TOKEN_EARLY_SECONDS = 60
_MESSAGE_LIMIT = 200


# ---- errors -----------------------------------------------------------------


class ZohoError(Exception):
    """A failed Zoho call. The message holds the HTTP status and Zoho's
    errorCode and message only; never tokens, secrets or document text."""

    def __init__(self, message: str, status: int | None = None, error_code: str | None = None):
        super().__init__(message)
        self.status = status
        self.error_code = error_code


class ZohoAuthError(ZohoError):
    pass


class ZohoRateLimitError(ZohoError):
    pass


class ZohoScanCapReached(ZohoError):
    pass


def _describe_error(status: int, body: Any) -> tuple[str, str | None]:
    code = message = None
    if isinstance(body, dict):
        code = body.get("errorCode") or body.get("error")
        message = body.get("message") or body.get("error_description")
    parts = [f"HTTP {status}"]
    if isinstance(code, str):
        parts.append(f"errorCode={code[:_MESSAGE_LIMIT]}")
    if isinstance(message, str):
        parts.append(f"message={message[:_MESSAGE_LIMIT]}")
    return ", ".join(parts), code if isinstance(code, str) else None


# ---- transport ----------------------------------------------------------------


@dataclass
class HttpResponse:
    status: int
    headers: dict = field(default_factory=dict)
    body: bytes = b""

    def header(self, name: str) -> str | None:
        wanted = name.lower()
        for key, value in self.headers.items():
            if key.lower() == wanted:
                return value
        return None

    def json(self) -> Any:
        """Parsed body, or None for an empty (e.g. 204) body."""
        if not self.body or not self.body.strip():
            return None
        return jsonlib.loads(self.body)


class HttpTransport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        headers: dict | None = None,
        params: dict | None = None,
        json: Any = None,
        files: dict | None = None,
        data: dict | None = None,
        timeout: float | None = None,
    ) -> HttpResponse: ...


class RequestsTransport:
    """Default transport using `requests`. `timeout` is the default for calls
    that do not pass their own."""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT):
        self.timeout = timeout

    def request(
        self, method, url, headers=None, params=None, json=None, files=None, data=None, timeout=None
    ):
        import requests

        try:
            resp = requests.request(
                method,
                url,
                headers=headers,
                params=params,
                json=json,
                files=files,
                data=data,
                timeout=self.timeout if timeout is None else timeout,
            )
        except requests.RequestException as exc:
            # The exception text can contain the URL; report only its type.
            raise ZohoError(f"network error: {type(exc).__name__}") from None
        return HttpResponse(resp.status_code, dict(resp.headers), resp.content)


# ---- tokens -------------------------------------------------------------------


class TokenProvider:
    def get_token(self) -> str:
        raise NotImplementedError

    def invalidate(self, stale_token: str | None = None) -> None:
        """Drop the cached token (only if it is still `stale_token`, when given)."""
        raise NotImplementedError


class RefreshTokenProvider(TokenProvider):
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        accounts_url: str,
        transport: HttpTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._client_id = client_id
        self._client_secret = client_secret
        self._refresh_token = refresh_token
        base = accounts_url.rstrip("/")
        self._token_url = base if base.endswith("/oauth/v2/token") else base + "/oauth/v2/token"
        self._transport = transport or RequestsTransport(timeout=30)
        self._clock = clock
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires_at = 0.0

    def get_token(self) -> str:
        with self._lock:
            if self._token is not None and self._clock() < self._expires_at - TOKEN_EARLY_SECONDS:
                return self._token
            self._refresh()
            return self._token  # type: ignore[return-value]

    def invalidate(self, stale_token: str | None = None) -> None:
        with self._lock:
            if stale_token is None or stale_token == self._token:
                self._token = None
                self._expires_at = 0.0

    def _refresh(self) -> None:
        try:
            resp = self._transport.request(
                "POST",
                self._token_url,
                data={
                    "grant_type": "refresh_token",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "refresh_token": self._refresh_token,
                },
            )
            body = resp.json()
        except ZohoError:
            raise
        except ValueError:
            raise ZohoAuthError("token refresh failed: unreadable response") from None
        token = body.get("access_token") if isinstance(body, dict) else None
        if resp.status != 200 or not isinstance(token, str) or not token:
            # Only status and Zoho's error code; the body is never echoed.
            code = body.get("error") if isinstance(body, dict) else None
            detail = f", error={code[:_MESSAGE_LIMIT]}" if isinstance(code, str) else ""
            raise ZohoAuthError(f"token refresh failed: HTTP {resp.status}{detail}", resp.status)
        try:
            lifetime = float(body.get("expires_in", 3600))
        except (TypeError, ValueError):
            lifetime = 3600.0
        self._token = token
        self._expires_at = self._clock() + lifetime


# ---- per-key locks --------------------------------------------------------------

_registry_lock = threading.Lock()
_key_locks: dict[tuple, threading.Lock] = {}


def _lock_for(key: tuple) -> threading.Lock:
    with _registry_lock:
        lock = _key_locks.get(key)
        if lock is None:
            lock = _key_locks[key] = threading.Lock()
        return lock


# ---- client ---------------------------------------------------------------------


class TicketScan:
    """Iterate to get pages (lists of tickets) of an account's tickets.

    After iteration: `pages_scanned`, and `scan_limit_reached` is True when
    the page cap was hit while pages were still full (older tickets may exist
    that were not checked).
    """

    def __init__(self, client: "ZohoClient", account_id: str, max_pages: int):
        self._client = client
        self._account_id = account_id
        self._max_pages = max_pages
        self.pages_scanned = 0
        self.scan_limit_reached = False

    def __iter__(self):
        for page_no in range(self._max_pages):
            data = self._client._get_list(
                f"/accounts/{self._account_id}/tickets", PAGE_SIZE, 1 + page_no * PAGE_SIZE
            )
            if not data:
                return
            self.pages_scanned += 1
            yield data
            if len(data) < PAGE_SIZE:
                return
            if page_no == self._max_pages - 1:
                self.scan_limit_reached = True


class ZohoClient:
    def __init__(
        self,
        token_provider: TokenProvider,
        org_id: str,
        desk_url: str,
        department_id: str,
        transport: HttpTransport | None = None,
        contact_email_domain: str = "example.com",
        sleep: Callable[[float], None] = time.sleep,
        low_rate_threshold: int = 30,
        low_rate_sleep: float = 2.0,
        retry_wait: float = 5.0,
        max_pages: int = MAX_PAGES,
    ):
        self._tokens = token_provider
        self._org_id = org_id
        self._base = desk_url.rstrip("/") + "/api/v1"
        self.department_id = department_id
        self._transport = transport or RequestsTransport()
        self._domain = contact_email_domain or "example.com"
        self._sleep = sleep
        self._low_threshold = low_rate_threshold
        self._low_sleep = low_rate_sleep
        self._retry_wait = retry_wait
        self._max_pages = max_pages
        self.rate_limit_remaining: int | None = None

    # -- low level --

    def _call(
        self, method, path, params=None, json=None, files=None, timeout=DEFAULT_TIMEOUT
    ) -> Any:
        url = self._base + path
        retried_auth = False
        rate_retries = 0
        while True:
            token = self._tokens.get_token()
            headers = {"Authorization": f"Zoho-oauthtoken {token}", "orgId": self._org_id}
            resp = self._transport.request(
                method, url, headers=headers, params=params, json=json, files=files, timeout=timeout
            )
            self._note_rate_limit(resp)
            if resp.status == 401 and not retried_auth:
                retried_auth = True
                self._tokens.invalidate(token)
                continue
            if resp.status == 429:
                if rate_retries >= 2:
                    raise ZohoRateLimitError(
                        "Zoho Desk rate limit: HTTP 429 after 2 retries", 429
                    )
                rate_retries += 1
                self._sleep(self._retry_wait * rate_retries)
                continue
            try:
                body = resp.json()
            except ValueError:
                body = None
                if resp.status < 400:
                    raise ZohoError(f"unreadable response: HTTP {resp.status}", resp.status) from None
            if resp.status >= 400:
                text, code = _describe_error(resp.status, body)
                raise ZohoError(f"Zoho Desk request failed: {text}", resp.status, code)
            return body

    def _note_rate_limit(self, resp: HttpResponse) -> None:
        raw = resp.header("x-rate-limit-remaining-v3")
        try:
            remaining = int(raw) if raw is not None else None
        except ValueError:
            remaining = None
        if remaining is None:
            return
        self.rate_limit_remaining = remaining
        if remaining <= self._low_threshold:
            self._sleep(self._low_sleep)

    def _get_list(self, path: str, limit: int, start: int) -> list[dict]:
        body = self._call("GET", path, params={"from": start, "limit": limit})
        if not body:  # 204 / empty
            return []
        data = body.get("data") if isinstance(body, dict) else None
        return data if isinstance(data, list) else []

    def _scan_all(self, path: str) -> list[dict]:
        """All items of a list endpoint, capped at max_pages pages; raises if
        the cap is hit while pages are still full."""
        items: list[dict] = []
        for page_no in range(self._max_pages):
            data = self._get_list(path, PAGE_SIZE, 1 + page_no * PAGE_SIZE)
            items.extend(data)
            if len(data) < PAGE_SIZE:
                return items
        raise ZohoScanCapReached(f"list scan cap reached ({self._max_pages} pages)")

    # -- accounts and contacts --

    def find_or_create_account(self, display_name: str) -> dict:
        """Return {id, name, created}. Matching is on the normalised name."""
        display, key = normalise_company(display_name)
        with _lock_for(("account", self._base, self._org_id, key)):
            for account in self._scan_all("/accounts"):
                name = account.get("accountName")
                if isinstance(name, str) and name.strip() and normalise_company(name)[1] == key:
                    return {"id": account["id"], "name": name, "created": False}
            created = self._call("POST", "/accounts", json={"accountName": display})
            return {"id": created["id"], "name": display, "created": True}

    def find_or_create_contact(self, account_id: str, company: str) -> dict:
        """Return {id, created} for the fixed "AuditFlow findings" contact."""
        wanted = CONTACT_LAST_NAME.casefold()
        with _lock_for(("contact", self._base, self._org_id, str(account_id))):
            for contact in self._scan_all(f"/accounts/{account_id}/contacts"):
                last = contact.get("lastName")
                if isinstance(last, str) and last.strip().casefold() == wanted:
                    return {"id": contact["id"], "created": False}
            slug = self._slug(normalise_company(company)[1])
            created = self._call(
                "POST",
                "/contacts",
                json={
                    "lastName": CONTACT_LAST_NAME,
                    "email": f"auditflow+{slug}@{self._domain}",
                    "accountId": account_id,
                },
            )
            return {"id": created["id"], "created": True}

    @staticmethod
    def _slug(match_key: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", match_key.lower()).strip("-")[:40].strip("-") or "company"

    # -- tickets --

    def list_account_tickets(self, account_id: str) -> TicketScan:
        return TicketScan(self, account_id, self._max_pages)

    def create_ticket(
        self, subject: str, description_html: str, contact_id: str, department_id: str | None = None
    ) -> dict:
        body = self._call(
            "POST",
            "/tickets",
            json={
                "subject": subject,
                "description": description_html,
                "contactId": contact_id,
                "departmentId": department_id or self.department_id,
                "channel": "Web",
            },
        )
        return {
            "ticket_number": body.get("ticketNumber"),
            "id": body.get("id"),
            "web_url": body.get("webUrl"),
        }

    def attach_file(self, ticket_id: str, filename: str, content_bytes: bytes) -> None:
        """One private file per call."""
        self._call(
            "POST",
            f"/tickets/{ticket_id}/attachments",
            files={"file": (filename, content_bytes), "isPublic": (None, "false")},
            timeout=UPLOAD_TIMEOUT,
        )

    def add_private_comment(self, ticket_id: str, text: str) -> None:
        self._call(
            "POST",
            f"/tickets/{ticket_id}/comments",
            json={"content": text, "isPublic": False},
        )
