#!/usr/bin/env python3
"""OpenFloat local server and OBS overlay relay.

Serves static app files and provides real-time overlay snapshot relay
between the browser (capturing BLE shots) and OBS Studio Browser Sources (CEF)
via HTTP REST and Server-Sent Events (SSE).

Requires only the Python 3 standard library.
"""

import http.server
import json
import os
import queue
import socketserver
import sys
import threading
import time

DEFAULT_PORT = 4178

class OverlayRelay:
    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers_lock = threading.Lock()
        self._latest_snapshot = None
        self._subscribers = set()

    def set_snapshot(self, snapshot_dict):
        raw_json = json.dumps(snapshot_dict)
        with self._lock:
            self._latest_snapshot = raw_json
        with self._subscribers_lock:
            subscribers_copy = list(self._subscribers)
        for q in subscribers_copy:
            try:
                q.put_nowait(raw_json)
            except Exception:
                pass

    def get_snapshot_json(self):
        with self._lock:
            return self._latest_snapshot

    def subscribe(self):
        q = queue.Queue(maxsize=30)
        with self._subscribers_lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self._subscribers_lock:
            self._subscribers.discard(q)


RELAY = OverlayRelay()


class OpenFloatHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, directory=None, **kwargs):
        if directory is None:
            directory = os.getcwd()
        super().__init__(*args, directory=directory, **kwargs)

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/overlay/snapshot":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                if content_len > 1_000_000:  # 1 MB limit
                    self.send_response(413)
                    self.end_headers()
                    return
                body = self.rfile.read(content_len)
                data = json.loads(body.decode("utf-8"))
                RELAY.set_snapshot(data)
                response = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(response)
            except Exception as e:
                err_msg = json.dumps({"error": str(e)}).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(err_msg)))
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(err_msg)
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/overlay/snapshot":
            snapshot = RELAY.get_snapshot_json()
            payload = (snapshot or "{}").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(payload)
            return

        if self.path == "/api/overlay/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self._send_cors_headers()
            self.end_headers()

            q = RELAY.subscribe()
            try:
                # Send current snapshot immediately on connect if available
                current = RELAY.get_snapshot_json()
                if current:
                    self.wfile.write(f"data: {current}\n\n".encode("utf-8"))
                    self.wfile.flush()

                # Stream new updates or heartbeats
                while True:
                    try:
                        msg = q.get(timeout=15)
                        self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except queue.Empty:
                        # Send SSE comment to keep connection alive
                        self.wfile.write(b": keep-alive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                RELAY.unsubscribe(q)
            return

        # Fallback to standard static file serving
        return super().do_GET()

    def log_message(self, format, *args):
        # Quiet standard SSE/API polling from flooding terminal if desired,
        # or log normally
        if "/api/overlay/" in (args[0] if args else ""):
            return
        super().log_message(format, *args)


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run(port=DEFAULT_PORT, directory=None):
    if directory is None:
        directory = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    os.chdir(directory)

    handler = lambda *args, **kwargs: OpenFloatHandler(*args, directory=directory, **kwargs)
    server = ThreadedHTTPServer(("0.0.0.0", port), handler)
    print(f"OpenFloat server running at http://localhost:{port}/")
    print(f"OBS Overlay relay active at http://localhost:{port}/api/overlay/")
    print("Serving files from:", directory)
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run(port)
