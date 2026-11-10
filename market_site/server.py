"""PINPOINT customer-facing demo site.
Only allowlisted customer API calls are proxied to the EXISTING PINPOINT server.
No admin token, signing key, capture, void, or lab mutation is routed here.
Local development only, bound to 127.0.0.1 by default.
"""
import os
import re
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

HERE=Path(__file__).resolve().parent
BACKEND=os.environ.get('PINPOINT_BACKEND','http://127.0.0.1:8877').rstrip('/')
HOST=os.environ.get('PINPOINT_BIND_HOST','127.0.0.1')
PORT=int(os.environ.get('PORT',os.environ.get('PINPOINT_MARKET_PORT','8878')))
GETS=[re.compile(r'^/api/(config|policies)$'),re.compile(r'^/api/payments/[A-Za-z0-9_-]+$')]
POSTS=[re.compile(r'^/api/checkouts$'),re.compile(r'^/api/mock-approve/[A-Za-z0-9_-]+$'),re.compile(r'^/api/payments/[A-Za-z0-9_-]+/authorize$')]
STUDIO_URL=os.environ.get('PINPOINT_STUDIO_URL','http://127.0.0.1:8877').rstrip('/')
if not re.fullmatch(r'https?://[A-Za-z0-9.:-]+', STUDIO_URL):
    raise ValueError('Invalid PINPOINT_STUDIO_URL')
FILES={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'}
class Handler(BaseHTTPRequestHandler):
    server_version='PINPOINTMarketDemo/1.0'
    def _reply(self,status,body,content_type='application/json; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        self.end_headers();self.wfile.write(body)
    def do_GET(self):
        path=urlsplit(self.path).path
        if path in FILES:
            p=HERE/FILES[path]
            mime='text/html; charset=utf-8' if p.suffix=='.html' else 'text/css; charset=utf-8' if p.suffix=='.css' else 'text/javascript; charset=utf-8'
            return self._reply(200,p.read_bytes().replace(b'http://127.0.0.1:8877', STUDIO_URL.encode()),mime)
        return self._proxy('GET',path) if any(rx.fullmatch(path) for rx in GETS) else self._reply(404,b'{"detail":"Not found"}')
    def do_POST(self):
        path=urlsplit(self.path).path
        if not any(rx.fullmatch(path) for rx in POSTS):return self._reply(403,b'{"detail":"This endpoint is not exposed on the buyer website"}')
        n=int(self.headers.get('Content-Length','0'))
        if n<0 or n>16384:return self._reply(413,b'{"detail":"Request too large"}')
        body=self.rfile.read(n) if n else b''
        return self._proxy('POST',path,body)
    def _proxy(self,method,path,body=None):
        try:
            url=BACKEND+path
            req=Request(url,data=body if method=='POST' else None,method=method,headers={'Content-Type':'application/json','Accept':'application/json'})
            with urlopen(req,timeout=25) as resp:result=resp.read(2*1024*1024);status=resp.status
            self._reply(status,result)
        except HTTPError as exc:self._reply(exc.code,exc.read(2*1024*1024))
        except (URLError,TimeoutError) as exc:self._reply(502,json.dumps({'detail':'PINPOINT backend unavailable on port 8877. Start it before using checkout.'}).encode())
        except Exception:self._reply(502,b'{"detail":"Customer-site proxy failed"}')

if __name__=='__main__':
    print(f'PINPOINT Market website: http://{HOST}:{PORT}')
    print(f'Existing Scenario Studio backend: {BACKEND}')
    print('Only allowlisted buyer routes are proxied; configure HTTPS and an authenticated Studio for real payments.')
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
