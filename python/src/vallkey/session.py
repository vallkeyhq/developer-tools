"""Short-lived keys for web pages and mobile apps, made on your server.

    from vallkey.session import create_session_key
    key = create_session_key(user=user.id)["session_key"]

VALLKEY_GHOST_KEY  the ghost key to make them from (or pass ghost_key)
VALLKEY_API        the Vallkey server (default https://api.vallkey.com)

Never call this from code that runs on a visitor's device: the ghost key would be there.
"""

import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

__all__ = ["create_session_key", "SessionKeyError"]


class SessionKeyError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "Gateway redirects are not allowed", headers, fp)


def create_session_key(user=None, ttl_seconds=None, allow=None, models=None, ghost_key=None, api=None, timeout=10):
    """Make a short-lived key. Returns {"session_key", "expires_at", "expires_in", "user"}."""
    ghost_key = ghost_key or os.environ.get("VALLKEY_GHOST_KEY")
    if not ghost_key:
        raise SessionKeyError("vallkey: set VALLKEY_GHOST_KEY, or pass ghost_key, to make short-lived keys")
    api = (api or os.environ.get("VALLKEY_API") or "https://api.vallkey.com").rstrip("/")
    try:
        target = urlsplit(api)
        port = target.port
        loopback = target.hostname in ("localhost", "127.0.0.1", "::1")
        if (target.scheme != "https" and not (target.scheme == "http" and loopback)) or not target.hostname or target.username is not None or target.password is not None or target.path not in ("", "/") or target.query or target.fragment or port == 0:
            raise ValueError()
    except ValueError:
        raise SessionKeyError("vallkey: use an HTTPS gateway origin; HTTP is allowed only for loopback tests") from None
    api = urlunsplit((target.scheme, target.netloc, "", "", ""))
    body = {}
    if user is not None:
        body["user"] = str(user)
    if ttl_seconds is not None:
        body["ttl_seconds"] = ttl_seconds
    if allow is not None:
        body["allow"] = allow
    if models is not None:
        body["models"] = models
    request = urllib.request.Request(
        f"{api}/_vallkey/v1/session-keys",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {ghost_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as err:
        try:
            message = json.loads(err.read())["error"]["message"]
        except Exception:
            message = f"could not make a short-lived key ({err.code})"
        raise SessionKeyError(f"vallkey: {message}", err.code) from None
