"""Generate a per-client access code for the AuditFlow API.

Not imported by the app. Usage:

    export AUDITFLOW_CODE_PEPPER=<the same secret the server uses>
    python scripts/make_access_code.py <client_id>

Prints the code ONCE (give it to the client; it cannot be recovered) and the
JSON entry to merge into the AUDITFLOW_ACCESS_CODES variable on the server.
The code is never written to any file.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sys


def main(argv: list[str]) -> int:
    pepper = os.environ.get("AUDITFLOW_CODE_PEPPER", "")
    if not pepper:
        print("AUDITFLOW_CODE_PEPPER is not set; export it first.", file=sys.stderr)
        return 1
    client_id = argv[1] if len(argv) > 1 else "client"

    code = "AF-" + secrets.token_urlsafe(18)
    digest = hmac.new(pepper.encode("utf-8"), code.encode("utf-8"), hashlib.sha256).hexdigest()
    entry = {
        client_id: {
            "hash": digest,
            "daily_runs": 10,
            "daily_tickets": 50,
            "max_files": 10,
            "max_file_mb": 20,
            "resolver": False,
        }
    }

    print(f"Access code (shown once, give it to the client): {code}\n")
    print("Entry for AUDITFLOW_ACCESS_CODES (merge into the existing JSON object):")
    print(json.dumps(entry, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
