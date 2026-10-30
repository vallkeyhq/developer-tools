import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from vallkey.session import SessionKeyError, create_session_key


class SessionTest(unittest.TestCase):
    def server(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return "http://127.0.0.1:%d" % server.server_address[1]

    def test_invalid_origins_are_rejected_before_network_access(self):
        for api in ("http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?key=x", "invalid"):
            with self.subTest(api=api), self.assertRaises(SessionKeyError):
                create_session_key(ghost_key="fixture", api=api)

    def test_redirects_do_not_forward_credentials(self):
        forwarded = []

        class Target(BaseHTTPRequestHandler):
            def do_POST(self):
                forwarded.append(self.headers.get("authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_):
                pass

        target = self.server(Target)

        class Redirect(Target):
            def do_POST(self):
                self.send_response(307)
                self.send_header("location", target)
                self.end_headers()

        with self.assertRaises(SessionKeyError) as error:
            create_session_key(ghost_key="ghost-fixture", api=self.server(Redirect))
        self.assertEqual(error.exception.status, 307)
        self.assertEqual(forwarded, [])

    def test_session_options_and_authorization_are_sent(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.path, self.headers.get("authorization"), json.loads(self.rfile.read(int(self.headers["content-length"])))))
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"session_key":"session-fixture"}')

            def log_message(self, *_):
                pass

        result = create_session_key(user=123, ttl_seconds=900, allow=[], ghost_key="ghost-fixture", api=self.server(Handler))
        self.assertEqual(result["session_key"], "session-fixture")
        self.assertEqual(seen, [("/_vallkey/v1/session-keys", "Bearer ghost-fixture", {"user": "123", "ttl_seconds": 900, "allow": []})])
