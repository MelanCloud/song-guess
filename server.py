#!/usr/bin/env python3
"""
Zero-dependency static server for Song Guess.

Binds to 127.0.0.1 on purpose: Spotify rejects `localhost` as a redirect URI,
and 127.0.0.1 is still a "potentially trustworthy" origin, so the Web Playback
SDK (which needs a secure context for EME/Widevine) works over plain HTTP.
"""

import http.server
import mimetypes
import os
import socketserver
import sys
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8080"))
ROOT = os.path.dirname(os.path.abspath(__file__))

# Windows reads MIME types from the registry, where .js is often mapped to
# text/plain. Browsers refuse to execute ES modules served that way, so pin them.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        # The OAuth redirect lands on /callback; the SPA reads ?code= from the URL.
        if urlsplit(self.path).path == "/callback":
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    try:
        with Server((HOST, PORT), Handler) as httpd:
            print(f"\n  Song Guess running at  http://{HOST}:{PORT}\n")
            print("  Redirect URI to register in your Spotify app:")
            print(f"    http://{HOST}:{PORT}/callback\n")
            print("  Press Ctrl+C to stop.\n")
            httpd.serve_forever()
    except OSError as e:
        if getattr(e, "errno", None) in (48, 98, 10048):
            print(f"\n  Port {PORT} is already in use.")
            print(f"  Try:  PORT=8888 python server.py")
            print(f"  (then register http://{HOST}:8888/callback instead)\n")
            sys.exit(1)
        raise
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
