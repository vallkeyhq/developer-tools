"""Redirect recognized ghost credentials in supported Python HTTP transports.

Install lazily as clients are imported. See README.md for configuration and
../docs/compatibility.md for interception boundaries and verification guidance.
"""

import base64
import importlib.abc
import importlib.util
import os
import re
import sys
import threading
from urllib.parse import unquote, urlsplit, urlunsplit

GHOST = re.compile(r"gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}")
GHOST_BYTES = re.compile(rb"gk_[a-z]{2,20}_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}")

_lock = threading.Lock()
_installed = False
_restore = []  # (owner, attribute, original)
_pending = set()


# ---- deciding ----


class _Target:
    def __init__(self):
        url = urlsplit(os.environ.get("VALLKEY_API") or "https://api.vallkey.com")
        self.scheme = url.scheme or "https"
        self.host = url.hostname or "api.vallkey.com"
        self.port = url.port
        self.netloc = self.host + (":%d" % self.port if self.port else "")
        self.origin = "%s://%s" % (self.scheme, self.netloc)


def _default_port(scheme):
    return 443 if scheme == "https" else 80


def _is_vallkey(host, port, scheme):
    t = _Target()
    return host == t.host and (port or _default_port(scheme)) == (t.port or _default_port(t.scheme))


def _in_value(value):
    if value is None:
        return False
    if isinstance(value, bytes):
        value = value.decode("latin-1")
    value = str(value)
    if GHOST.search(value):
        return True
    m = re.match(r"^\s*basic\s+([A-Za-z0-9+/=]+)\s*$", value, re.I)
    if not m:
        return False
    try:
        return bool(GHOST.search(base64.b64decode(m.group(1)).decode("latin-1")))
    except Exception:
        return False


def _has_ghost(query, headers, body=None):
    if query and GHOST.search(unquote(query if isinstance(query, str) else query.decode("latin-1"))):
        return True
    for _, value in headers:
        if _in_value(value):
            return True
    if isinstance(body, str):
        return bool(GHOST.search(body))
    if isinstance(body, (bytes, bytearray)):
        return bool(GHOST_BYTES.search(body))
    return False


HOOK_HEADER = "x-vallkey-host"
WHO_HEADER = "x-vallkey-hook"

# The platform, from variables each one sets itself. The same list, in the same order, is
# in every Vallkey hook, so the dashboard names a place the same way in any language.
PLATFORMS = [
    ("VERCEL", "vercel"),
    ("AWS_LAMBDA_FUNCTION_NAME", "aws-lambda"),
    ("ECS_CONTAINER_METADATA_URI_V4", "aws-ecs"),
    ("ECS_CONTAINER_METADATA_URI", "aws-ecs"),
    ("FUNCTION_TARGET", "cloud-functions"),
    ("K_SERVICE", "cloud-run"),
    ("GAE_APPLICATION", "app-engine"),
    ("FUNCTIONS_WORKER_RUNTIME", "azure-functions"),
    ("CONTAINER_APP_NAME", "azure-container-apps"),
    ("WEBSITE_SITE_NAME", "azure-app-service"),
    ("RAILWAY_PROJECT_ID", "railway"),
    ("RENDER", "render"),
    ("FLY_APP_NAME", "fly"),
    ("DYNO", "heroku"),
    ("NETLIFY", "netlify"),
    ("KOYEB_APP_NAME", "koyeb"),
    ("GITHUB_ACTIONS", "github-actions"),
    ("GITLAB_CI", "gitlab-ci"),
    ("KUBERNETES_SERVICE_HOST", "kubernetes"),
]
_who = None


def _who_value():
    global _who
    if _who is None:
        import platform

        from vallkey import __version__

        parts = ["python/%s" % __version__, "runtime=%s" % platform.python_version()]
        place = next((name for var, name in PLATFORMS if os.environ.get(var)), None)
        if place is None and os.path.exists("/.dockerenv"):
            place = "docker"
        if place:
            parts.append("platform=%s" % place)
        env = os.environ.get("VALLKEY_ENV", "")
        if re.match(r"^[A-Za-z0-9._-]{1,40}$", env):
            parts.append("env=%s" % env)
        _who = "; ".join(parts)
    return _who


def _netloc(scheme, host, port):
    return host + (":%s" % port if port and port != _default_port(scheme) else "")


def _log(scheme, host, port, path, target):
    if os.environ.get("VALLKEY_DEBUG") == "1":
        shown = host + (":%s" % port if port and port != _default_port(scheme) else "")
        sys.stderr.write("[vallkey] %s://%s -> %s\n" % (scheme, shown, target.origin))


def _remember(owner, name, wrapper):
    original = getattr(owner, name)
    if getattr(original, "_vallkey", False):
        return
    wrapper._vallkey = True
    wrapper.__wrapped__ = original
    _restore.append((owner, name, original))
    setattr(owner, name, wrapper)


# ---- httpx ----


def _rewrite_httpx(request):
    try:
        url = request.url
        if url.scheme not in ("http", "https") or _is_vallkey(url.host, url.port, url.scheme):
            return
        try:
            body = request.content
        except Exception:  # a streamed body that has not been read
            body = None
        if not _has_ghost(url.query, request.headers.multi_items(), body):
            return
        t = _Target()
        _log(url.scheme, url.host, url.port, url.path, t)
        request.headers[HOOK_HEADER] = _netloc(url.scheme, url.host, url.port)
        request.headers[WHO_HEADER] = _who_value()
        request.url = url.copy_with(scheme=t.scheme, host=t.host, port=t.port)
        request.headers["Host"] = t.netloc
    except Exception:
        pass  # anything unusual goes out as it was


def _patch_httpx(httpx):
    # _send_single_request runs once per request after auth and redirects are applied.
    name = "_send_single_request" if hasattr(httpx.Client, "_send_single_request") else "send"
    sync_original = getattr(httpx.Client, name)
    async_original = getattr(httpx.AsyncClient, name)

    def send(self, request, *args, **kwargs):
        _rewrite_httpx(request)
        return sync_original(self, request, *args, **kwargs)

    async def send_async(self, request, *args, **kwargs):
        _rewrite_httpx(request)
        return await async_original(self, request, *args, **kwargs)

    _remember(httpx.Client, name, send)
    _remember(httpx.AsyncClient, name, send_async)


# ---- requests ----


def _patch_requests(requests):
    import requests.adapters

    original = requests.adapters.HTTPAdapter.send

    def send(self, request, *args, **kwargs):
        try:
            u = urlsplit(request.url)
            body = request.body if isinstance(request.body, (str, bytes, bytearray)) else None
            if u.scheme in ("http", "https") and not _is_vallkey(u.hostname, u.port, u.scheme) and _has_ghost(u.query, request.headers.items(), body):
                t = _Target()
                _log(u.scheme, u.hostname, u.port, u.path, t)
                request.url = urlunsplit((t.scheme, t.netloc, u.path, u.query, u.fragment))
                request.headers.pop("Host", None)
                request.headers[HOOK_HEADER] = _netloc(u.scheme, u.hostname, u.port)
                request.headers[WHO_HEADER] = _who_value()
        except Exception:
            pass
        return original(self, request, *args, **kwargs)

    _remember(requests.adapters.HTTPAdapter, "send", send)


# ---- urllib3 on its own ----


def _patch_urllib3(urllib3):
    # PoolManager.urlopen takes the full address; requests goes past it (straight to a
    # connection pool), so a request is never changed twice.
    original = urllib3.PoolManager.urlopen

    def urlopen(self, method, url, *args, **kwargs):
        try:
            u = urlsplit(url)
            headers = kwargs.get("headers")
            if headers is None:
                headers = self.headers
            body = kwargs.get("body")
            if u.scheme in ("http", "https") and not _is_vallkey(u.hostname, u.port, u.scheme) and _has_ghost(u.query, list(headers.items()), body if isinstance(body, (str, bytes, bytearray)) else None):
                t = _Target()
                _log(u.scheme, u.hostname, u.port, u.path, t)
                url = urlunsplit((t.scheme, t.netloc, u.path, u.query, u.fragment))
                moved = {k: v for k, v in headers.items() if str(k).lower() != "host"}
                moved[HOOK_HEADER] = _netloc(u.scheme, u.hostname, u.port)
                moved[WHO_HEADER] = _who_value()
                kwargs["headers"] = moved
        except Exception:
            pass
        return original(self, method, url, *args, **kwargs)

    _remember(urllib3.PoolManager, "urlopen", urlopen)


# ---- botocore (boto3) ----


def _patch_botocore(httpsession):
    # botocore asks urllib3 for a connection to the host itself, past PoolManager.urlopen.
    original = httpsession.URLLib3Session.send

    def send(self, request):
        try:
            u = urlsplit(request.url)
            body = request.body if isinstance(request.body, (str, bytes, bytearray)) else None
            if u.scheme in ("http", "https") and not _is_vallkey(u.hostname, u.port, u.scheme) and _has_ghost(u.query, request.headers.items(), body):
                t = _Target()
                _log(u.scheme, u.hostname, u.port, u.path, t)
                request.url = urlunsplit((t.scheme, t.netloc, u.path, u.query, u.fragment))
                if "Host" in request.headers:
                    del request.headers["Host"]
                request.headers[HOOK_HEADER] = _netloc(u.scheme, u.hostname, u.port)
                request.headers[WHO_HEADER] = _who_value()
        except Exception:
            pass
        return original(self, request)

    _remember(httpsession.URLLib3Session, "send", send)


# ---- aiohttp ----


def _patch_aiohttp(aiohttp):
    from yarl import URL

    original = aiohttp.ClientSession._request

    async def _request(self, method, str_or_url, *args, **kwargs):
        try:
            url = URL(str(str_or_url))
            base = getattr(self, "_base_url", None)
            if not url.is_absolute() and base is not None:
                url = base.join(url)
            if url.scheme in ("http", "https") and not _is_vallkey(url.host, url.port, url.scheme):
                headers = []
                for source in (getattr(self, "_default_headers", None), kwargs.get("headers")):
                    if source:
                        headers.extend(source.items())
                auth = kwargs.get("auth") or getattr(self, "_default_auth", None)
                if auth is not None and getattr(auth, "password", None):
                    headers.append(("authorization-password", auth.password))
                params = kwargs.get("params")
                if isinstance(params, dict):
                    headers.extend((k, v) for k, v in params.items() if isinstance(v, str))
                data = kwargs.get("data")
                if _has_ghost(url.query_string, headers, data if isinstance(data, (str, bytes)) else None):
                    t = _Target()
                    _log(url.scheme, url.host, url.port, url.path, t)
                    str_or_url = url.with_scheme(t.scheme).with_host(t.host).with_port(t.port)
                    moved = {k: v for k, v in (kwargs.get("headers") or {}).items() if str(k).lower() != "host"}
                    moved[HOOK_HEADER] = _netloc(url.scheme, url.host, url.port)
                    moved[WHO_HEADER] = _who_value()
                    kwargs["headers"] = moved
        except Exception:
            pass
        return await original(self, method, str_or_url, *args, **kwargs)

    _remember(aiohttp.ClientSession, "_request", _request)


# ---- urllib ----


def _patch_urllib(urllib_request):
    import http.client

    original = urllib_request.AbstractHTTPHandler.do_open

    def do_open(self, http_class, req, **kwargs):
        try:
            u = urlsplit(req.full_url)
            headers = list(req.headers.items()) + list(req.unredirected_hdrs.items())
            body = req.data if isinstance(req.data, (bytes, str)) else None
            if u.scheme in ("http", "https") and not _is_vallkey(u.hostname, u.port, u.scheme) and _has_ghost(u.query, headers, body):
                t = _Target()
                _log(u.scheme, u.hostname, u.port, u.path, t)
                req.full_url = urlunsplit((t.scheme, t.netloc, u.path, u.query, u.fragment))
                req.unredirected_hdrs["Host"] = t.netloc
                req.unredirected_hdrs[HOOK_HEADER.capitalize()] = _netloc(u.scheme, u.hostname, u.port)
                req.unredirected_hdrs[WHO_HEADER.capitalize()] = _who_value()
                if "Host" in req.headers:
                    req.headers["Host"] = t.netloc
                if t.scheme != u.scheme:
                    http_class = http.client.HTTPSConnection if t.scheme == "https" else http.client.HTTPConnection
                    if t.scheme == "http":
                        kwargs.pop("context", None)
                        kwargs.pop("check_hostname", None)
        except Exception:
            pass
        return original(self, http_class, req, **kwargs)

    _remember(urllib_request.AbstractHTTPHandler, "do_open", do_open)


# ---- installing, now or when the library is imported ----

_PATCHERS = {
    "httpx": _patch_httpx,
    "httpx2": _patch_httpx,  # the successor of httpx, used by newer OpenAI and Anthropic SDKs
    "requests": _patch_requests,
    "urllib3": _patch_urllib3,
    "botocore.httpsession": _patch_botocore,
    "aiohttp": _patch_aiohttp,
    "urllib.request": _patch_urllib,
}


def _apply(name, module):
    try:
        _PATCHERS[name](module)
    except Exception:
        pass  # an unexpected version of the library: leave it as it is


class _Loader(importlib.abc.Loader):
    def __init__(self, loader, name):
        self._loader = loader
        self._name = name

    def create_module(self, spec):
        return self._loader.create_module(spec)

    def exec_module(self, module):
        self._loader.exec_module(module)
        _pending.discard(self._name)
        _apply(self._name, module)

    def __getattr__(self, attr):
        return getattr(self._loader, attr)


class _Finder(importlib.abc.MetaPathFinder):
    _busy = threading.local()

    def find_spec(self, fullname, path, target=None):
        if fullname not in _pending or getattr(self._busy, "on", False):
            return None
        self._busy.on = True
        try:
            spec = importlib.util.find_spec(fullname)
        except Exception:
            return None
        finally:
            self._busy.on = False
        if spec is None or spec.loader is None:
            return None
        spec.loader = _Loader(spec.loader, fullname)
        return spec


_finder = _Finder()


def install():
    """Start sending requests that carry a ghost key to Vallkey. Safe to call twice."""
    global _installed
    with _lock:
        if _installed:
            return
        _installed = True
        for name in _PATCHERS:
            module = sys.modules.get(name)
            if module is not None:
                _apply(name, module)
            else:
                _pending.add(name)
        if _pending and _finder not in sys.meta_path:
            sys.meta_path.insert(0, _finder)


def uninstall():
    """Undo install()."""
    global _installed
    with _lock:
        while _restore:
            owner, name, original = _restore.pop()
            setattr(owner, name, original)
        _pending.clear()
        if _finder in sys.meta_path:
            sys.meta_path.remove(_finder)
        _installed = False
