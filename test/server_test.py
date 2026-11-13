#!/usr/bin/env python3
"""Tests for tools/server.py OBS overlay relay and static file serving."""

import http.client
import json
import os
import threading
import time
import unittest
import urllib.request

from tools.server import OpenFloatHandler, ThreadedHTTPServer, RELAY


class ServerRelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Pick a port for testing
        cls.port = 49153
        repo_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        handler = lambda *args, **kwargs: OpenFloatHandler(*args, directory=repo_dir, **kwargs)
        cls.server = ThreadedHTTPServer(("127.0.0.1", cls.port), handler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_static_file_serving(self):
        url = f"http://127.0.0.1:{self.port}/index.html"
        with urllib.request.urlopen(url) as req:
            self.assertEqual(req.status, 200)
            content = req.read().decode("utf-8")
            self.assertIn("obsOverlayRoot", content)

    def test_snapshot_post_and_get(self):
        sample = {
            "shotCount": 42,
            "plannedShots": 60,
            "latestShot": {"shot_score": 95},
            "locale": "pt-BR",
        }
        post_url = f"http://127.0.0.1:{self.port}/api/overlay/snapshot"
        data = json.dumps(sample).encode("utf-8")
        req = urllib.request.Request(
            post_url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            res_body = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(res_body.get("ok"))

        # Verify GET returns the snapshot
        get_url = f"http://127.0.0.1:{self.port}/api/overlay/snapshot"
        with urllib.request.urlopen(get_url) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), "*")
            fetched = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(fetched["shotCount"], 42)
            self.assertEqual(fetched["locale"], "pt-BR")

    def test_sse_streaming(self):
        # Connect to SSE endpoint
        sse_url = f"http://127.0.0.1:{self.port}/api/overlay/events"
        req = urllib.request.Request(sse_url)
        resp = urllib.request.urlopen(req)
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "text/event-stream")

        # Post an update in background
        def post_update():
            time.sleep(0.05)
            sample = {"shotCount": 99, "plannedShots": 100}
            post_url = f"http://127.0.0.1:{self.port}/api/overlay/snapshot"
            data = json.dumps(sample).encode("utf-8")
            p_req = urllib.request.Request(
                post_url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(p_req) as p_resp:
                pass

        t = threading.Thread(target=post_update)
        t.start()

        # Read line from SSE stream
        line = resp.readline().decode("utf-8")
        while line.startswith(":") or not line.strip():
            line = resp.readline().decode("utf-8")
        self.assertTrue(line.startswith("data: "))
        data = json.loads(line[6:])
        self.assertIn("shotCount", data)
        resp.close()
        t.join()

    def test_cors_options(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("OPTIONS", "/api/overlay/snapshot")
        res = conn.getresponse()
        self.assertEqual(res.status, 204)
        self.assertEqual(res.getheader("Access-Control-Allow-Origin"), "*")
        self.assertIn("POST", res.getheader("Access-Control-Allow-Methods"))
        conn.close()


if __name__ == "__main__":
    unittest.main()
