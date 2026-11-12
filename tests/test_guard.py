"""The Host allow-list and the same-origin rule for writes (svgdeck.guard)."""
import json

import pytest
from starlette.testclient import TestClient

from svgdeck import browser
from svgdeck.cli import main
from svgdeck.guard import hosts_from_env, split_host
from svgdeck.server import create_app

TAILNET = "machine.example.ts.net"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SVGDECK_HOSTS", f"{TAILNET}, *.wild.example")
    return TestClient(create_app(tmp_path), base_url="http://127.0.0.1:8490")


def make(client, name="talk", **headers):
    return client.post("/api/decks", json={"name": name, "title": "T"}, headers=headers)


def test_loopback_and_configured_hosts_are_served(client):
    for host in ["127.0.0.1:8490", "localhost:8490", "[::1]:8490", "127.0.0.1", f"{TAILNET}:8490",
                 TAILNET.upper(), f"{TAILNET}.", "a.wild.example:1"]:
        assert client.get("/api/decks", headers={"Host": host}).status_code == 200, host


def test_other_hosts_are_refused(client):
    for host in ["evil.example", "evil.example:8490", "127.0.0.1.evil.example", f"{TAILNET}.evil.example",
                 "wild.example", "", "127.0.0.1:99999", "user@127.0.0.1", "[::1"]:
        r = client.get("/api/decks", headers={"Host": host})
        assert r.status_code == 400, host
    assert client.get("/", headers={"Host": "evil.example"}).status_code == 400


def test_writes_without_origin_pass(client):
    assert make(client).status_code == 200   # curl, scripts, agents on loopback


def test_same_origin_writes_pass(client):
    assert make(client, "a", Origin="http://127.0.0.1:8490", **{"Sec-Fetch-Site": "same-origin"}).status_code == 200
    # Through Tailscale Serve: the browser's Host and Origin arrive unchanged.
    r = make(client, "b", Host=f"{TAILNET}:8490", Origin=f"https://{TAILNET}:8490")
    assert r.status_code == 200
    # On a default port the Host header has no port.
    assert make(client, "c", Host=TAILNET, Origin=f"https://{TAILNET}").status_code == 200


def test_foreign_origin_writes_are_refused(client):
    for origin in ["https://evil.example", "null", f"https://{TAILNET}:5001", "http://127.0.0.1:8491",
                   "http://localhost:8490", "file://", "chrome-extension://abc"]:
        r = make(client, Origin=origin)
        assert r.status_code == 403, origin
    put = client.put("/api/decks/talk/slides/x", content=b"<svg/>", headers={"Origin": "https://evil.example"})
    assert put.status_code == 403
    assert client.delete("/api/decks/talk", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/decks") .json() == []   # nothing was made


def test_cross_site_fetch_metadata_is_refused(client):
    r = make(client, **{"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    # Reads stay open to the service's own pages and to plain links.
    assert client.get("/api/decks", headers={"Origin": "https://evil.example",
                                             "Sec-Fetch-Site": "cross-site"}).status_code == 200


def test_no_cors_headers(client):
    r = client.options("/api/decks", headers={"Origin": "https://evil.example",
                                              "Access-Control-Request-Method": "POST"})
    assert not any(k.lower().startswith("access-control-") for k in r.headers)


def test_no_host_header_is_the_listening_address(tmp_path):
    import asyncio
    app = create_app(tmp_path)

    async def call(server):
        out = []
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}
        async def send(message):
            out.append(message)
        await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.0", "method": "GET",
                   "scheme": "http", "path": "/healthz", "raw_path": b"/healthz", "query_string": b"",
                   "headers": [], "client": ("127.0.0.1", 1), "server": server}, receive, send)
        return out[0]["status"]
    assert asyncio.run(call(("127.0.0.1", 8490))) == 200
    assert asyncio.run(call(("0.0.0.0", 8490))) == 400


def test_split_host_and_env():
    assert split_host("Example.ORG:8490") == ("example.org", 8490)
    assert split_host("[::1]:80") == ("::1", 80)
    assert split_host("a b") is None and split_host("x:y") is None
    assert hosts_from_env("a.example, b.example  c.example.") == ["a.example", "b.example", "c.example"]


def test_cli_passes_allow_host(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.delenv("SVGDECK_HOSTS", raising=False)
    monkeypatch.setattr("uvicorn.run", lambda app, **kw: seen.update(app=app, **kw))
    main(["serve", "--data", str(tmp_path), "--allow-host", TAILNET, "--port", "1"])
    c = TestClient(seen["app"], base_url=f"http://{TAILNET}:8490")
    assert c.get("/api/decks").status_code == 200
    assert TestClient(seen["app"], base_url="http://evil.example").get("/api/decks").status_code == 400


def test_the_browser_build_has_no_guard(tmp_path):
    """The worker's requests carry no Host or Origin; boot() leaves the guard out."""
    browser.boot(str(tmp_path))
    try:
        assert not any(m.cls.__name__ == "RequestGuard" for m in browser._app.user_middleware)
    finally:
        browser._app = browser._store = None
