"""Self-contained, read-only tail of one terminal, run on the host that owns it.

The caller prefixes `PID = <int or None>` and `PANE = <str or None>`. Readable terminals are tmux panes
(found by walking from the process up to a pane's shell) and Herdr panes. A process whose terminal is
neither is reported as unreadable; nothing else is opened. Output is the last lines only, with escape
sequences removed and common credential shapes masked.
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

def peek():
    if PANE:
        lines = herdr_read(PANE)
        if lines is not None: return {'status': 'ok', 'source': 'herdr', 'lines': lines}
    if PID:
        lines = tmux_read(PID)
        if lines is not None: return {'status': 'ok', 'source': 'tmux', 'lines': lines}
    return {'status': 'unreadable', 'lines': [], 'reason': 'This terminal is not a tmux or Herdr pane, so its output cannot be read from outside.'}

if __name__ == '__main__':
    print(json.dumps(peek()))
