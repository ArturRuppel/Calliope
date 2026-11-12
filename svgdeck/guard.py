"""Who may talk to the service: a Host allow-list and a same-origin rule for writes.

The service binds loopback and is published to the owner's devices by a
reverse proxy (Tailscale Serve), which passes the browser's Host header on
unchanged. Two things a web page elsewhere could otherwise do:

- DNS rebinding: a name the attacker controls resolves to 127.0.0.1, and the
  page reads the decks as its own origin. Refused by the Host allow-list:
  127.0.0.1, localhost and ::1, plus the names in $SVGDECK_HOSTS (comma
  separated, e.g. the machine's tailnet name) or --allow-host. An entry
  "*.example.net" allows every subdomain of example.net.
- Cross-site writes: the API reads bodies whatever their Content-Type, so a
  form on any site could POST to it without a preflight. Every request but
  GET, HEAD and OPTIONS is refused when the browser says it is cross-site
  (Sec-Fetch-Site) or its Origin is not the origin the request was sent to.
  A request with no Origin (curl, scripts and agents on loopback) is not a
  browser's cross-site request and passes.

No CORS headers are sent: nothing outside the service's own pages needs them.
"""
from __future__ import annotations

import os
from collections.abc import Iterable
from urllib.parse import urlsplit

from starlette.responses import PlainTextResponse

LOOPBACK = ("127.0.0.1", "localhost", "::1")
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
DEFAULT_PORTS = {"http": 80, "https": 443}


def hosts_from_env(value: str | None = None) -> list[str]:
    """The extra host names in $SVGDECK_HOSTS: comma or space separated."""
    value = os.environ.get("SVGDECK_HOSTS", "") if value is None else value
    return [h.strip().lower().rstrip(".") for h in value.replace(",", " ").split() if h.strip()]


def split_host(value: str) -> tuple[str, int | None] | None:
    """A Host header (or an Origin's netloc) as (name, port); None if malformed."""
    value = value.strip().lower()
    if not value or any(c in value for c in "/@?#\\ "):
        return None
    if value.startswith("["):
        end = value.find("]")
        if end < 0:
            return None
        name, rest = value[1:end], value[end + 1:]
    else:
        name, colon, port = value.partition(":")
        rest = colon + port
    if rest and not (rest.startswith(":") and rest[1:].isdigit() and 0 < int(rest[1:]) < 65536):
        return None
    return name.rstrip("."), (int(rest[1:]) if rest else None)


class RequestGuard:
    """ASGI middleware: Host allow-list for every request, same-origin for writes."""

    def __init__(self, app, hosts: Iterable[str] = ()):
        self.app = app
        self.exact = set(LOOPBACK)
        self.suffixes = []
        for host in hosts:
            host = host.strip().lower().rstrip(".")
            if host.startswith("*."):
                self.suffixes.append(host[1:])
            elif host:
                self.exact.add(host.strip("[]"))

    def allowed(self, name: str) -> bool:
        return name in self.exact or any(name.endswith(s) for s in self.suffixes)

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {}
        for key, value in scope.get("headers", []):
            headers.setdefault(key.decode("latin-1").lower(), value.decode("latin-1"))
        if "host" in headers:
            host = split_host(headers["host"])
        else:
            # HTTP/1.0 or a direct ASGI call: no name was asked for, so it is
            # the address the server listens on (what a browser always sends
            # a Host for, and so what DNS rebinding cannot reach this way).
            server = scope.get("server") or ("", None)
            host = (str(server[0]).lower(), server[1])
        if host is None or not self.allowed(host[0]):
            return await PlainTextResponse("Invalid host header", status_code=400)(scope, receive, send)
        if scope["type"] == "http" and scope.get("method", "GET").upper() not in SAFE_METHODS:
            problem = self.cross_origin(headers, host)
            if problem:
                return await PlainTextResponse(problem, status_code=403)(scope, receive, send)
        return await self.app(scope, receive, send)

    @staticmethod
    def cross_origin(headers: dict, host: tuple[str, int | None]) -> str | None:
        if headers.get("sec-fetch-site", "").strip().lower() == "cross-site":
            return "Cross-site requests may not change anything here"
        origin = headers.get("origin")
        if origin is None:
            return None
        parts = urlsplit(origin.strip())
        target = split_host(parts.netloc) if parts.scheme in DEFAULT_PORTS else None
        if target is None:
            return "Requests from another origin may not change anything here"   # includes "null"
        name, port = target
        port = port or DEFAULT_PORTS[parts.scheme]
        # The Host header leaves out the scheme's default port; behind an
        # HTTPS proxy it reaches us without one, so either default matches.
        host_ports = {host[1]} if host[1] else set(DEFAULT_PORTS.values())
        if name != host[0] or port not in host_ports:
            return "Requests from another origin may not change anything here"
        return None
