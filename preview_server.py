#!/usr/bin/env python3
"""L&F 本地预览服务器：静态文件来自 public/，/api/* 反向代理到线上 Worker（真实数据）。
   python3 -m http.server 做不到这点，所以自写一个 ~120 行的处理器。
   启动： nohup python3 preview_server.py > preview.log 2>&1 &
"""
import http.server, socketserver, urllib.request, urllib.error, ssl, sys, os, subprocess

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')
UPSTREAM = 'https://lostnfound.ominx.dpdns.org'
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
        cmd = ['curl', '-sS', '-L', '--http1.1', '--max-time', '25', '--retry', '2', '--retry-all-errors',
               '-X', self.command, '-w', '\n__LF_STATUS__%{http_code}\n__LF_TYPE__%{content_type}']
        for h in ('Content-Type', 'X-Admin-Token', 'Accept', 'Accept-Language', 'User-Agent'):
            if self.headers.get(h):
                cmd += ['-H', f'{h}: {self.headers[h]}']
        if body is not None:
            cmd += ['--data-binary', '@-']
        cmd += [UPSTREAM + self.path]
        try:
            r = subprocess.run(cmd, input=body, capture_output=True, timeout=85)
            if r.returncode:
                raise RuntimeError(r.stderr.decode('utf-8', 'replace')[:180])
            marker = r.stdout.rfind(b'\n__LF_STATUS__')
            if marker < 0:
                raise RuntimeError('Missing curl status')
            data = r.stdout[:marker]
            meta = r.stdout[marker:].decode('utf-8', 'replace')
            status = int(meta.split('__LF_STATUS__', 1)[1].splitlines()[0])
            ct = meta.split('__LF_TYPE__', 1)[1].strip() if '__LF_TYPE__' in meta else 'application/json'
            self.send_response(status)
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
