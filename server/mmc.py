#!/usr/bin/env python3
"""Mesh Mission Control: a read-only HTTPS bridge that the Android app (or any client) reads.

  mmc.py serve [--bind 0.0.0.0] [--port 18877] [--allow-peek]
  mmc.py hosts                       list configured hosts
  mmc.py add NAME ADDRESS [--user U] [--port N] [--key PATH]
  mmc.py remove NAME
  mmc.py discover [--lan] [--tailnet] [--add]
  mmc.py pair                        print the URL, token and certificate fingerprint to enter in the app
"""
import argparse, hmac, json, ssl, socket, sys, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import config, discover, probe

VERSION = '1.0.0'
PORT = 18877
CACHE_SECONDS = 20
MAX_BODY = 16384
lock = threading.Lock()
cache = {'at': 0, 'body': None}
ALLOW_PEEK = False  # set by --allow-peek: lets the app read the last lines of one terminal on demand

def state():
    hosts = config.load_hosts()
    outer = probe.collect(hosts)
    warnings = [] if hosts else ['No hosts configured. Add one in the app (Hosts) or run: mmc.py add NAME ADDRESS']
    return {'peek': ALLOW_PEEK, 'generatedAt': time.time(), 'inventoryAt': None, 'nodes': [], 'sessions': [], 'warnings': warnings,
            'configured': [h['name'] for h in hosts], 'outerHosts': outer}

class Handler(BaseHTTPRequestHandler):
    server_version = 'MeshMissionControl/' + VERSION

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.token)

    def body(self):
        try: length = int(self.headers.get('Content-Length') or 0)
        except ValueError: length = -1
        if not 0 <= length <= MAX_BODY: raise ValueError('Body too large')
        return json.loads(self.rfile.read(length) or b'{}')

    def route(self, method):
        path = self.path.split('?')[0]
        if method == 'GET' and path == '/api/hello':
            return 200, {'app': 'mesh-mission-control', 'version': VERSION, 'name': socket.gethostname(), 'fingerprint': self.server.fingerprint}
        if not self.authorized(): return 403, {'error': 'Forbidden'}
        if method == 'GET' and path == '/api/state':
            with lock:
                if cache['body'] is None or time.time() - cache['at'] >= CACHE_SECONDS:
                    cache.update(at=time.time(), body=state())
                return 200, cache['body']
        if method == 'GET' and path == '/api/peek':
            if not ALLOW_PEEK: return 403, {'error': 'Peek is off. Start the server with --allow-peek.'}
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            host = next((h for h in config.load_hosts() if h['name'] == (q.get('host') or [''])[0]), None)
            pid = (q.get('pid') or [''])[0]
            if host is None: return 404, {'error': 'No such host'}
            try: return 200, probe.peek(host, int(pid) if pid.isdigit() else None, (q.get('pane') or [None])[0])
            except ValueError: return 400, {'error': 'Bad request'}
            except (OSError, subprocess.SubprocessError): return 502, {'error': 'Host unavailable'}
        if method == 'GET' and path == '/api/hosts': return 200, {'hosts': config.load_hosts()}
        if method == 'POST' and path == '/api/hosts':
            host = config.add_host(self.body()); cache['body'] = None
            return 200, {'host': host}
        if method == 'DELETE' and path.startswith('/api/hosts/'):
            try: config.remove_host(path[len('/api/hosts/'):])
            except KeyError: return 404, {'error': 'No such host'}
            cache['body'] = None
            return 200, {'ok': True}
        if method == 'POST' and path == '/api/discover':
            options = self.body()
            return 200, {'candidates': discover.discover(options.get('lan', True) is not False, options.get('tailnet', True) is not False)}
        return 404, {'error': 'Not found'}

    def handle_any(self, method):
        try: status, payload = self.route(method)
        except ValueError as error: status, payload = 400, {'error': str(error)}
        except (OSError, json.JSONDecodeError): status, payload = 500, {'error': 'Server error'}
        self.reply(status, payload)

    def do_GET(self): self.handle_any('GET')
    def do_POST(self): self.handle_any('POST')
    def do_DELETE(self): self.handle_any('DELETE')
    def log_message(self, *args): pass

def serve(bind, port):
    cert, key = config.certificate()
    server = ThreadingHTTPServer((bind, port), Handler)
    server.token, server.fingerprint = config.token(), config.fingerprint()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key); server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print(f'Mesh Mission Control {VERSION} listening on https://{bind}:{port}', flush=True)
    print_pairing(port)
    server.serve_forever()

def print_pairing(port):
    addresses = [a for a in config.local_addresses() if a != '127.0.0.1']
    print('Enter in the app:  ' + ' or '.join(f'{a}:{port}' for a in addresses))
    print('Token:             ' + config.token())
    print('Certificate SHA-256 (the app shows this to confirm):\n  ' + config.fingerprint(), flush=True)

def main(argv=None):
    parser = argparse.ArgumentParser(prog='mmc.py', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    s = sub.add_parser('serve'); s.add_argument('--bind', default='0.0.0.0'); s.add_argument('--port', type=int, default=PORT); s.add_argument('--allow-peek', action='store_true')
    sub.add_parser('hosts')
    a = sub.add_parser('add'); a.add_argument('name'); a.add_argument('address'); a.add_argument('--user'); a.add_argument('--port', type=int); a.add_argument('--key')
    r = sub.add_parser('remove'); r.add_argument('name')
    d = sub.add_parser('discover'); d.add_argument('--lan', action='store_true'); d.add_argument('--tailnet', action='store_true'); d.add_argument('--add', action='store_true', help='add everything found; set --user first with `add` if logins differ')
    d.add_argument('--user')
    p = sub.add_parser('pair'); p.add_argument('--port', type=int, default=PORT)
    args = parser.parse_args(argv)
    if args.command == 'serve':
        global ALLOW_PEEK
        ALLOW_PEEK = args.allow_peek
        serve(args.bind, args.port)
    elif args.command == 'hosts':
        for h in config.load_hosts(): print(h['name'], h['address'], h.get('user', ''), h.get('port', ''), h.get('key', ''))
    elif args.command == 'add':
        host = config.add_host({'name': args.name, 'address': args.address, 'user': args.user, 'port': args.port, 'key': args.key})
        result = probe.probe(host); print(f"Added {host['name']}: {result['status']}")
        if result['status'] != 'ok': print('Could not read it yet. Check that `ssh ' + (host.get('user', '') + '@' if host.get('user') else '') + host['address'] + ' python3 --version` works without a password.')
    elif args.command == 'remove': config.remove_host(args.name)
    elif args.command == 'discover':
        both = not (args.lan or args.tailnet)
        found = discover.discover(args.lan or both, args.tailnet or both)
        for c in found: print(f"{c['source']:8} {c['name']:30} {c['address']:16} {c['os']}")
        if args.add:
            for c in found: config.add_host({'name': c['name'], 'address': c['address'], 'user': args.user})
            print(f'Added {len(found)} hosts. They show as unavailable until SSH login works.')
    elif args.command == 'pair': print_pairing(args.port)

if __name__ == '__main__': main()
