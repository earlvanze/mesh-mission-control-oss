"""Collect a read-only snapshot from every configured host, over SSH or locally."""
import concurrent.futures, json, math, pathlib, re, shlex, subprocess, sys, time
import config
import agent

AGENT_SOURCE = pathlib.Path(agent.__file__).read_text()
SCRIPT = AGENT_SOURCE.replace("if __name__=='__main__':", "if True:")

def ssh_argv(host, remote):
    argv = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'UserKnownHostsFile=' + str(config.private_dir() / 'known_hosts')]
    if host.get('key'): argv += ['-o', 'IdentitiesOnly=yes', '-i', host['key']]
    if host.get('port'): argv += ['-p', str(host['port'])]
    target = (host['user'] + '@' if host.get('user') else '') + host['address']
    return argv + [target, remote]

def run_script(host, script, timeout=30):
    if host['address'] == 'local':
        return subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=timeout, check=True).stdout
    return subprocess.run(ssh_argv(host, shlex.join(['python3', '-c', script])), capture_output=True, text=True, timeout=timeout, check=True).stdout

def run_agent(host, timeout=30):
    return json.loads(run_script(host, SCRIPT, timeout))

PEEK_SOURCE = (pathlib.Path(__file__).parent / 'peek_agent.py').read_text()

def peek(host, pid=None, pane=None):
    """Last lines of one tmux or Herdr terminal on a configured host. Arguments are validated before they reach the script."""
    if not ((type(pid) is int and 0 < pid < 2 ** 31) or (isinstance(pane, str) and re.fullmatch(r'[A-Za-z0-9_:.%-]{1,64}', pane))): raise ValueError('Bad request')
    script = 'PID=%r\nPANE=%r\n%s' % (pid, pane or None, PEEK_SOURCE)
    result = json.loads(run_script(host, script, 25))
    if result.get('status') not in ('ok', 'unreadable') or not isinstance(result.get('lines'), list) or not all(isinstance(x, str) for x in result['lines']): raise ValueError('Invalid peek')
    return {'host': host['name'], 'status': result['status'], 'source': result.get('source', ''), 'lines': result['lines'][-40:], 'reason': str(result.get('reason', ''))[:200], 'at': time.time()}

def _count_map(counts):
    return isinstance(counts, dict) and all(k in agent.RUNTIMES and type(v) is int and v > 0 for k, v in counts.items())

def _processes(items):
    return isinstance(items, list) and all(isinstance(x, dict) and x.get('runtime') in agent.RUNTIMES and type(x.get('pid')) is int and x['pid'] > 0
        and ('cwd' not in x or (isinstance(x['cwd'], str) and x['cwd'].startswith('/') and len(x['cwd']) <= 4096)) for x in items)

def explain(host, error):
    """A short, fixed-text reason a host could not be read; raw ssh output is never passed on."""
    if isinstance(error, subprocess.TimeoutExpired): return 'Timed out reaching the host'
    text = (getattr(error, 'stderr', '') or '').lower()
    who = (host['user'] + '@' if host.get('user') else '') + host['address']
    if 'host key verification failed' in text or 'identification has changed' in text: return 'Host key changed; check it, then remove its line from known_hosts'
    if 'permission denied' in text: return 'SSH login refused for ' + who + '. Set the right SSH user or authorize the bridge key (ssh-copy-id)'
    if 'connection refused' in text: return 'Nothing is listening for SSH on ' + host['address']
    if 'could not resolve' in text or 'no route' in text or 'unreachable' in text: return 'Host not reachable at ' + host['address']
    if 'timed out' in text: return 'Timed out reaching ' + host['address']
    if 'not found' in text and 'python' in text: return 'python3 is not installed on the host'
    if isinstance(error, (ValueError, TypeError, KeyError, IndexError)): return 'The host answered with something unexpected'
    return 'Could not run the check on the host'

def probe(host):
    now = time.time()
    try:
        raw = run_agent(host)
        resources = agent.validate(raw['resources'])
        presence = raw['presence']
        if not (_count_map(presence['counts']) and _processes(presence['processes'])): raise ValueError('Invalid process details')
        return {'host': host['name'], 'status': 'ok', 'observedAt': now, **resources,
                'processes': {'status': 'ok', 'counts': presence['counts'], 'processes': presence['processes'], 'observedAt': now}}
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError, IndexError) as error:
        return {'host': host['name'], 'status': 'unavailable', 'reason': explain(host, error), 'observedAt': now, 'processes': {'status': 'unavailable', 'counts': {}, 'observedAt': now}}

def collect(hosts):
    if not hosts: return []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, len(hosts))) as pool:
        return list(pool.map(probe, hosts))
