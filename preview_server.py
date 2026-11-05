#!/usr/bin/env python3
"""L&F 本地预览服务器：静态文件来自 public/，/api/* 反向代理到线上 Worker（真实数据）。
   python3 -m http.server 做不到这点，所以自写一个 ~120 行的处理器。
   启动： nohup python3 preview_server.py > preview.log 2>&1 &
"""
import http.server, socketserver, urllib.request, urllib.error, ssl, sys, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')
UPSTREAM = 'https://lf.xiaochangblog.dpdns.org'
PORT = int(os.environ.get('PREVIEW_PORT', '8123'))
CTX = ssl.create_default_context()

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # ---------- 静态文件 ----------
    def translate_path(self, path):
        p = super().translate_path(path)
        # /kiosk -> /kiosk.html、/admin -> /admin.html（模拟线上 307 的规范路径）
        if not os.path.exists(p):
            if os.path.exists(p + '.html'):
                return p + '.html'
        return p

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')   # 开发预览禁用缓存
        super().end_headers()

    # ---------- API 反代 ----------
    def _proxy(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command)
        for h in ('Content-Type', 'X-Admin-Token', 'Accept', 'Accept-Language', 'User-Agent'):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                data = r.read()
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() in ('transfer-encoding', 'connection', 'content-length'):
                        continue
                    self.send_header(k, v)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            ct = e.headers.get('Content-Type')
            if ct:
                self.send_header('Content-Type', ct)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)
        except Exception as e:
            msg = ('{"ok":false,"error":"PREVIEW_PROXY_ERROR","detail":%r}' % str(e)).encode()
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):
        if self.path.startswith('/api/') or self.path == '/api':
            return self._proxy()
        if self.path.startswith('/r'):
            self.send_response(302)
            self.send_header('Location', '/?from=qr')
            self.end_headers()
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.startswith('/api/'):
            return self._proxy()
        super().do_HEAD()

    def do_POST(self):
        return self._proxy() if self.path.startswith('/api/') else self.send_error(405)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == '__main__':
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print(f'L&F preview: http://127.0.0.1:{PORT}/  (static=public/, api->{UPSTREAM})', flush=True)
        httpd.serve_forever()
