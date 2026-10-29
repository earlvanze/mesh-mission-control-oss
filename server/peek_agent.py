"""Self-contained, read-only tail of one agent's recent output, run on the host that owns it.

The caller prefixes `PID = <int or None>` and `PANE = <str or None>`. In order: a Herdr pane, a tmux pane
(found by walking from the process up to a pane's shell), then the Codex or Claude Code session transcript
that process has open or, for Claude, that belongs to its working directory. Anything else is reported as
unreadable; no other file is opened. Output is the last lines only, with escape sequences removed and
common credential shapes masked.
"""
import glob, json, os, re, shutil, subprocess

LINES = 40
WIDTH = 300
SECRETS = re.compile(r'(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}'
                     r'|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,}'
                     r'|(?i:(?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)\S{6,})')
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]')

def run(cmd, timeout=6):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=True).stdout

def clean(text):
    lines = [SECRETS.sub('[masked]', ANSI.sub('', line))[:WIDTH].rstrip() for line in text.splitlines()]
    while lines and not lines[-1]: lines.pop()
    return lines[-LINES:]

def ancestors(pid):
    chain = []
    while pid and pid > 1 and pid not in chain and len(chain) < 40:
        chain.append(pid)
        try: pid = int(run(['ps', '-o', 'ppid=', '-p', str(pid)]).strip() or 0)
        except (OSError, subprocess.SubprocessError, ValueError): break
    return chain

def tmux_sockets():
    sockets = [None]
    sockets += sorted(glob.glob('/tmp/tmux-%d/*' % os.getuid())) + sorted(glob.glob('/private/tmp/tmux-%d/*' % os.getuid()))
    return sockets

def tmux_read(pid):
    tmux = shutil.which('tmux')
    if not tmux: return None
    chain = set(ancestors(pid))
    for sock in tmux_sockets():
        base = [tmux] + (['-S', sock] if sock else [])
        try: panes = run(base + ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']).splitlines()
        except (OSError, subprocess.SubprocessError): continue
        for line in panes:
            pane, _, shell = line.partition(' ')
            if shell.isdigit() and int(shell) in chain:
                try: return clean(run(base + ['capture-pane', '-p', '-J', '-t', pane, '-S', '-%d' % (LINES * 3)]))
                except (OSError, subprocess.SubprocessError): return None
    return None

def herdr_read(pane):
    herdr = shutil.which('herdr') or next((c for c in ('/usr/bin/herdr', '/usr/local/bin/herdr', '/opt/homebrew/bin/herdr', os.path.expanduser('~/.local/bin/herdr')) if os.access(c, os.X_OK)), None)
    if not herdr or not re.match(r'^[A-Za-z0-9_:.%-]{1,64}$', pane or ''): return None
    try: return clean(run([herdr, 'pane', 'read', pane, '--lines', str(LINES * 3), '--format', 'text'], 8))
    except (OSError, subprocess.SubprocessError): return None

def descendants(pid):
    kids, chain = {}, [pid]
    try:
        for line in run(['ps', '-A', '-o', 'pid=', '-o', 'ppid=']).splitlines():
            a, b = line.split()[:2]
            kids.setdefault(int(b), []).append(int(a))
    except (OSError, subprocess.SubprocessError, ValueError, IndexError): return chain
    for p in chain:
        chain += [k for k in kids.get(p, []) if k not in chain][:50]
        if len(chain) > 200: break
    return chain

def transcript_path(pid):
    home = os.path.expanduser('~')
    roots = (home + '/.codex/sessions/', home + '/.claude/projects/')
    for p in descendants(pid):
        try: fds = os.listdir('/proc/%d/fd' % p)
        except OSError: continue
        for fd in fds:
            try: path = os.readlink('/proc/%d/fd/%s' % (p, fd))
            except OSError: continue
            if path.endswith('.jsonl') and path.startswith(roots): return path
    try: cwd = os.readlink('/proc/%d/cwd' % pid)
    except OSError:
        try:
            out = run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'])
            cwd = next(l[1:] for l in out.splitlines() if l.startswith('n/'))
        except (OSError, subprocess.SubprocessError, StopIteration): return None
    folder = os.path.join(home, '.claude/projects', re.sub(r'[^A-Za-z0-9]', '-', cwd))
    files = sorted(glob.glob(folder + '/*.jsonl'), key=os.path.getmtime)
    return files[-1] if files else None

def summarize(value, limit=160):
    text = ' '.join(str(value).split())
    return text[:limit] + ('…' if len(text) > limit else '')

def entries(record):
    """(label, text) pairs from one Codex or Claude Code transcript line."""
    out = []
    payload = record.get('payload') if isinstance(record.get('payload'), dict) else {}
    message = record.get('message') if isinstance(record.get('message'), dict) else payload
    role = message.get('role') if message.get('type') in (None, 'message') else None
    if payload.get('type') == 'function_call':
        return [('tool', payload.get('name', '') + ' ' + summarize(payload.get('arguments', ''), 120))]
    if role in ('user', 'assistant'):
        content = message.get('content')
        for part in ([{'type': 'text', 'text': content}] if isinstance(content, str) else content or []):
            if not isinstance(part, dict): continue
            if part.get('type') in ('text', 'input_text', 'output_text') and part.get('text', '').strip():
                if not part['text'].lstrip().startswith('<'): out.append(('you' if role == 'user' else 'agent', summarize(part['text'], 300)))
            elif part.get('type') == 'tool_use':
                args = part.get('input') or {}
                out.append(('tool', part.get('name', '') + ' ' + summarize(args.get('command') or args.get('file_path') or args.get('pattern') or args.get('description') or '', 120)))
    return out

def transcript_read(pid):
    path = transcript_path(pid)
    if not path: return None
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 400000))
            raw = f.read().decode('utf-8', 'replace').splitlines()
    except OSError: return None
    lines = []
    for line in raw[1:] if size > 400000 else raw:
        try: record = json.loads(line)
        except ValueError: continue
        if isinstance(record, dict): lines += ['%s: %s' % pair for pair in entries(record)]
    return clean('\n'.join(lines)) if lines else None

def peek():
    if PANE:
        lines = herdr_read(PANE)
        if lines is not None: return {'status': 'ok', 'source': 'herdr', 'lines': lines}
    if PID:
        lines = tmux_read(PID)
        if lines is not None: return {'status': 'ok', 'source': 'tmux', 'lines': lines}
        lines = transcript_read(PID)
        if lines is not None: return {'status': 'ok', 'source': 'transcript', 'lines': lines}
    return {'status': 'unreadable', 'lines': [], 'reason': 'Not a tmux or Herdr pane, and no Codex or Claude Code transcript was found for it, so its output cannot be read from outside.'}

if __name__ == '__main__':
    print(json.dumps(peek()))
