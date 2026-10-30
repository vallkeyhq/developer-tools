import json
import os
import subprocess
import sys
import textwrap
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Shaped like a ghost key, put together at run time.
GHOST = "_".join(["gk", "openai", "A1b2C3d4E5f6G7h8I9j0Kl", "M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI"])
SEEN = []


def server(name):
    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            SEEN.append({"server": name, "method": self.command, "path": self.path, "host": self.headers.get("host"), "from": self.headers.get("x-vallkey-host"), "hook": self.headers.get("x-vallkey-hook"), "body": body})
            data = json.dumps({"from": name}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = _answer

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def has(module):
    try:
        __import__(module)
        return True
    except ImportError:
        if os.environ.get("VALLKEY_REQUIRE_TEST_DEPS") == "1":
            raise RuntimeError("Required test transport is missing: " + module)
        return False


class AutoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vallkey = server("vallkey")
        cls.provider = server("provider")
        cls.vport = cls.vallkey.server_address[1]
        cls.provider_url = "http://127.0.0.1:%d" % cls.provider.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.vallkey.shutdown()
        cls.provider.shutdown()

    def run_py(self, code, **env):
        src = os.path.join(os.path.dirname(__file__), "..", "src")
        full = {"PATH": os.environ["PATH"], "PYTHONPATH": src, "VALLKEY_API": "http://127.0.0.1:%d" % self.vport, "GHOST": GHOST, **env}
        r = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True, env=full, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip(), r.stderr

    def last(self):
        return SEEN[-1]

    def test_urllib_with_a_ghost_key_goes_to_vallkey(self):
        out, _ = self.run_py(
            """
            import vallkey.auto, os, json, urllib.request
            req = urllib.request.Request('https://api.openai.com/v1/models?limit=2', headers={'Authorization': 'Bearer ' + os.environ['GHOST']})
            print(json.load(urllib.request.urlopen(req))['from'])
            """
        )
        self.assertEqual(out, "vallkey")
        self.assertEqual((self.last()["path"], self.last()["host"], self.last()["from"]), ("/v1/models?limit=2", "127.0.0.1:%d" % self.vport, "api.openai.com"))

    def test_says_what_sent_the_request(self):
        import platform

        from vallkey import __version__

        out, _ = self.run_py(
            """
            import vallkey.auto, os, json, urllib.request
            req = urllib.request.Request('https://api.openai.com/v1/models', headers={'Authorization': 'Bearer ' + os.environ['GHOST']})
            print(json.load(urllib.request.urlopen(req))['from'])
            """,
            FLY_APP_NAME="x",
            VALLKEY_ENV="eu-workers",
        )
        self.assertEqual(out, "vallkey")
        self.assertEqual(self.last()["hook"], "python/%s; runtime=%s; platform=fly; env=eu-workers" % (__version__, platform.python_version()))

    def test_requests_without_a_ghost_key_are_left_alone(self):
        out, _ = self.run_py(
            """
            import vallkey.auto, json, urllib.request
            req = urllib.request.Request('%s/x', headers={'Authorization': 'Bearer sk-real'})
            print(json.load(urllib.request.urlopen(req))['from'])
            """
            % self.provider_url
        )
        self.assertEqual(out, "provider")

    @unittest.skipUnless(has("requests"), "requests is not installed")
    def test_requests_including_basic_auth_and_libraries_imported_first(self):
        out, _ = self.run_py(
            """
            import os, requests
            import vallkey.auto  # after requests: still covered
            a = requests.post('https://api.stripe.com/v1/customers', data={'email': 'a@b.c'}, headers={'Authorization': 'Bearer ' + os.environ['GHOST'], 'Host': 'api.stripe.com'})
            b = requests.get('https://api.twilio.com/2010-04-01/Accounts.json', auth=('AC1', os.environ['GHOST']))
            c = requests.get('%s/plain')
            print(a.json()['from'], b.json()['from'], c.json()['from'])
            """
            % self.provider_url
        )
        self.assertEqual(out, "vallkey vallkey provider")
        stripe = next(s for s in SEEN if s["path"] == "/v1/customers")
        self.assertEqual((stripe["method"], stripe["host"], stripe["body"], stripe["from"]), ("POST", "127.0.0.1:%d" % self.vport, "email=a%40b.c", "api.stripe.com"))

    @unittest.skipUnless(has("urllib3"), "urllib3 is not installed")
    def test_urllib3_on_its_own(self):
        out, _ = self.run_py(
            """
            import vallkey.auto, os, urllib3
            pool = urllib3.PoolManager(headers={'x-api-key': os.environ['GHOST']})
            a = pool.request('POST', 'https://api.pinecone.io/indexes', body=b'{}')
            b = urllib3.request('GET', 'https://api.mailchimp.com/3.0/ping', headers={'Authorization': 'apikey ' + os.environ['GHOST']})
            c = pool.request('GET', '%s/plain', headers={})
            print(a.json()['from'], b.json()['from'], c.json()['from'])
            """
            % self.provider_url
        )
        self.assertEqual(out, "vallkey vallkey provider")
        idx = next(s for s in SEEN if s["path"] == "/indexes")
        self.assertEqual((idx["method"], idx["host"], idx["from"]), ("POST", "127.0.0.1:%d" % self.vport, "api.pinecone.io"))

    @unittest.skipUnless(has("httpx"), "httpx is not installed")
    def test_httpx_sync_and_async_with_keys_in_headers_and_query(self):
        out, _ = self.run_py(
            """
            import vallkey.auto, os, asyncio, httpx
            g = os.environ['GHOST']
            a = httpx.post('https://api.anthropic.com/v1/messages', headers={'x-api-key': g}, json={'model': 'm'})
            async def main():
                async with httpx.AsyncClient() as c:
                    return (await c.get('https://generativelanguage.googleapis.com/v1beta/models', params={'key': g})).json()['from']
            print(a.json()['from'], asyncio.run(main()), httpx.get('%s/plain').json()['from'])
            """
            % self.provider_url
        )
        self.assertEqual(out, "vallkey vallkey provider")
        msg = next(s for s in SEEN if s["path"] == "/v1/messages")
        self.assertEqual((msg["method"], msg["host"], json.loads(msg["body"]), msg["from"]), ("POST", "127.0.0.1:%d" % self.vport, {"model": "m"}, "api.anthropic.com"))
        self.assertTrue(any(s["path"].startswith("/v1beta/models?key=gk_") for s in SEEN))

    @unittest.skipUnless(has("httpx2"), "httpx2 is not installed")
    def test_httpx2_sync_and_async(self):
        out, _ = self.run_py(
            """
            import vallkey.auto, os, asyncio, httpx2
            a = httpx2.get('https://api.openai.com/v1/models', headers={'authorization': 'Bearer ' + os.environ['GHOST']})
            async def main():
                async with httpx2.AsyncClient() as c:
                    return (await c.get('https://api.openai.com/v1/files', headers={'authorization': 'Bearer ' + os.environ['GHOST']})).json()['from']
            print(a.json()['from'], asyncio.run(main()), httpx2.get('%s/plain').json()['from'])
            """
            % self.provider_url
        )
        self.assertEqual(out, "vallkey vallkey provider")

    @unittest.skipUnless(has("aiohttp"), "aiohttp is not installed")
    def test_aiohttp(self):
        out, _ = self.run_py(
            """
            import vallkey.auto, os, asyncio, aiohttp
            async def main():
                async with aiohttp.ClientSession(headers={'Authorization': 'Bearer ' + os.environ['GHOST']}) as s:
                    async with s.post('https://api.resend.com/emails', json={}) as r:
                        a = (await r.json())['from']
                async with aiohttp.ClientSession() as s:
                    async with s.get('%s/plain') as r:
                        b = (await r.json())['from']
                return a, b
            print(*asyncio.run(main()))
            """
            % self.provider_url
        )
        self.assertEqual(out, "vallkey provider")
        self.assertTrue(any(s["path"] == "/emails" and s["server"] == "vallkey" for s in SEEN))

    def test_debug_log_never_shows_the_key_and_uninstall_undoes_it(self):
        out, err = self.run_py(
            """
            import vallkey, vallkey.auto, os, json, urllib.request
            req = lambda: urllib.request.Request('%s/x', headers={'Authorization': 'Bearer ' + os.environ['GHOST']})
            a = json.load(urllib.request.urlopen(req()))['from']
            vallkey.uninstall()
            print(a, json.load(urllib.request.urlopen(req()))['from'])
            """
            % self.provider_url,
            VALLKEY_DEBUG="1",
        )
        self.assertEqual(out, "vallkey provider")
        self.assertRegex(err, r"\[vallkey\] http://127\.0\.0\.1:\d+ -> http://127\.0\.0\.1:%d" % self.vport)
        self.assertNotIn(GHOST, err)
        self.assertNotIn("/x", err)


if __name__ == "__main__":
    unittest.main()
