#!/usr/bin/env python3
"""
Local development server for book-tracker.

Serves the site and adds the one thing a static host cannot: a save endpoint
that writes data/books.json back to disk, so logging a book produces a normal
file change you can review and commit.

    python3 tools/serve.py

Standard library only, and bound to 127.0.0.1 so the save endpoint is never
reachable from the network.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import webbrowser
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "books.json"
BACKUP_FILE = ROOT / "data" / "books.backup.json"

# Private notes are kept out of books.json and out of git, so that committing
# and publishing the library cannot publish them. See .gitignore.
NOTES_FILE = ROOT / "data" / "notes.json"
NOTES_BACKUP = ROOT / "data" / "notes.backup.json"

# The only data file that is committed. Aggregates only — no book records.
PUBLIC_FILE = ROOT / "data" / "public.json"
PUBLIC_BACKUP = ROOT / "data" / "public.backup.json"

MAX_BODY = 32 * 1024 * 1024  # 32 MB — far above any real library


class Handler(SimpleHTTPRequestHandler):
    """Static file server plus a tiny JSON save API."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # -- routes ------------------------------------------------------------

    def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self.path.rstrip("/") == "/api/status":
            return self._send_json(
                200, {"ok": True, "dataFile": str(DATA_FILE.relative_to(ROOT))}
            )
        return super().do_GET()

    def do_PUT(self):  # noqa: N802
        return self._route_save()

    def do_POST(self):  # noqa: N802
        # Accept POST as well, so a fetch() that omits the method still works.
        return self._route_save()

    def _route_save(self):
        route = self.path.rstrip("/")
        if route == "/api/books":
            return self._save_books()
        if route == "/api/notes":
            return self._save_notes()
        if route == "/api/public":
            return self._save_public()
        return self._send_json(404, {"error": "Not found"})

    # -- save --------------------------------------------------------------

    def _read_json_body(self):
        """Read and parse a JSON body. Returns (payload, error_response_sent)."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send_json(400, {"error": "Bad Content-Length"})
            return None, True

        if length <= 0:
            self._send_json(400, {"error": "Empty body"})
            return None, True
        if length > MAX_BODY:
            self._send_json(413, {"error": "Body too large"})
            return None, True

        raw = self.rfile.read(length)

        # Validate before touching any file. A malformed payload must never be
        # able to destroy a library that took years to accumulate.
        try:
            return json.loads(raw.decode("utf-8")), False
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": f"Invalid JSON: {exc}"})
            return None, True

    def _save_books(self):
        payload, failed = self._read_json_body()
        if failed:
            return None

        if not isinstance(payload, dict) or not isinstance(payload.get("books"), list):
            return self._send_json(
                400, {"error": 'Expected an object with a "books" array'}
            )

        # Backstop for the rule the client already enforces: books.json is the
        # file that gets committed and published, so it never carries notes.
        leaked = [
            b.get("title", "?")
            for b in payload["books"]
            if isinstance(b, dict) and (b.get("privateNotes") or "").strip()
        ]
        if leaked:
            self.log_message(
                "stripped private notes from %d book(s) before writing", len(leaked)
            )
            for b in payload["books"]:
                if isinstance(b, dict) and b.get("privateNotes"):
                    b["privateNotes"] = ""

        try:
            write_json(DATA_FILE, BACKUP_FILE, payload)
        except OSError as exc:
            return self._send_json(500, {"error": f"Write failed: {exc}"})

        count = len(payload["books"])
        self.log_message("saved %d books to %s", count, DATA_FILE.name)
        return self._send_json(
            200, {"ok": True, "count": count, "notesStripped": len(leaked)}
        )

    def _save_public(self):
        payload, failed = self._read_json_body()
        if failed:
            return None

        if not isinstance(payload, dict) or "totals" not in payload:
            return self._send_json(
                400, {"error": 'Expected an aggregate object with "totals"'}
            )

        # public.json is the one data file that gets committed and served, so
        # refuse anything that looks like a book record. The client already
        # audits; this is the backstop that cannot be bypassed by a stale page.
        leaks = find_identifying_fields(payload)
        if leaks:
            self.log_message("REFUSED public.json — identifying fields: %s", leaks)
            return self._send_json(
                422,
                {"error": "Refused: payload contains book-identifying fields",
                 "fields": leaks[:10]},
            )

        try:
            write_json(PUBLIC_FILE, PUBLIC_BACKUP, payload)
        except OSError as exc:
            return self._send_json(500, {"error": f"Write failed: {exc}"})

        self.log_message("saved aggregates to %s", PUBLIC_FILE.name)
        return self._send_json(200, {"ok": True})

    def _save_notes(self):
        payload, failed = self._read_json_body()
        if failed:
            return None

        if not isinstance(payload, dict) or not isinstance(payload.get("notes"), dict):
            return self._send_json(
                400, {"error": 'Expected an object with a "notes" object'}
            )

        try:
            write_json(NOTES_FILE, NOTES_BACKUP, payload)
        except OSError as exc:
            return self._send_json(500, {"error": f"Write failed: {exc}"})

        count = len(payload["notes"])
        self.log_message("saved %d private note(s) to %s", count, NOTES_FILE.name)
        return self._send_json(200, {"ok": True, "count": count})

    # -- helpers -----------------------------------------------------------

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Always serve fresh files; a cached books.json during editing is
        # confusing in exactly the moment you are checking your work.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


BANNED_KEYS = {
    "title", "isbn", "isbn13", "privatenotes", "review", "dateread",
    "datestarted", "dateadded", "contentwarnings",
}


def find_identifying_fields(node, path="$"):
    """Report any key that could name or pin down an individual book.

    A count called "books" is fine; a list of book records called "books" is
    not, so the check is on shape as well as name. There are no exceptions:
    nothing published names a book.
    """
    found = []
    if isinstance(node, list):
        for i, v in enumerate(node):
            found += find_identifying_fields(v, f"{path}[{i}]")
    elif isinstance(node, dict):
        for k, v in node.items():
            here = f"{path}.{k}"
            if k.lower() in BANNED_KEYS and isinstance(v, str) and v.strip():
                found.append(here)
            if (k == "books" and isinstance(v, list)
                    and any(isinstance(x, dict) for x in v)):
                found.append(f"{here} (list of records)")
            found += find_identifying_fields(v, here)
    return found


def write_json(target: Path, backup: Path, payload: dict) -> None:
    """Write a JSON file atomically, keeping one backup of the previous copy."""
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        shutil.copy2(target, backup)

    payload.setdefault("version", 1)
    payload["updated"] = date.today().isoformat()

    tmp = target.with_suffix(".json.tmp")
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    tmp.write_text(text, encoding="utf-8")
    # Atomic replace: a crash mid-write leaves the old file intact.
    os.replace(tmp, target)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--no-browser", action="store_true", help="do not open a browser window"
    )
    args = parser.parse_args()

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        print(f"Could not bind port {args.port}: {exc}", file=sys.stderr)
        print(f"Try: python3 tools/serve.py --port {args.port + 1}", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{args.port}/"
    print(f"book-tracker running at {url}")
    print(f"  library : {DATA_FILE.relative_to(ROOT)}")
    print(f"  log form: {url}log.html")
    print("Ctrl-C to stop.\n")

    if not args.no_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
