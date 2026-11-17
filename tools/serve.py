"""多线程静态服务器。

python -m http.server 是单线程的：45 MB 的主角模型一占住，
其他并发请求全部排队，页面 boot 直接卡死。这里换成 ThreadingHTTPServer。
"""
import sys
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8133
    root = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    srv = ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=root))
    srv.daemon_threads = True
    print(f'serving {root} on {port}', flush=True)
    srv.serve_forever()
