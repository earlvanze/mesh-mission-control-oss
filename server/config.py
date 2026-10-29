"""Configuration, credentials and the self-signed certificate. Everything lives in one private directory."""
import hashlib, json, os, pathlib, re, secrets, socket, ssl, subprocess

HOME = pathlib.Path(os.environ.get('MMC_HOME') or pathlib.Path.home() / '.config/mesh-mission-control')
# Container bridges, VPN and virtual interfaces are not addresses a phone or tablet would use.
SKIP_IFACES = ('lo', 'docker', 'br-', 'veth', 'virbr', 'cni', 'flannel')
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$')
ADDRESS_RE = re.compile(r'^(local|[A-Za-z0-9][A-Za-z0-9._:-]{0,252})$')
USER_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_.-]{0,31}$')

def private_dir():
    HOME.mkdir(parents=True, exist_ok=True)
    os.chmod(HOME, 0o700)
    return HOME

def token():
    """Bearer token for the API; created on first use and readable only by this user."""
    path = private_dir() / 'token'
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f: f.write(secrets.token_urlsafe(32) + '\n')
    return path.read_text().strip()

def local_addresses():
    found = {'127.0.0.1'}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET): found.add(info[4][0])
    except OSError: pass
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr', 'show'], capture_output=True, text=True, timeout=5).stdout
        found.update(ip for iface, ip in re.findall(r'^\d+:\s+(\S+)\s+inet (\d+\.\d+\.\d+\.\d+)/', out, re.M) if not iface.startswith(SKIP_IFACES))
    except (OSError, subprocess.SubprocessError): pass
    return sorted(found)

def certificate():
    """(cert_path, key_path); generates a 10-year self-signed certificate with openssl on first use."""
    cert, key = private_dir() / 'server.crt', private_dir() / 'server.key'
    if not (cert.exists() and key.exists()):
        sans = ','.join(['DNS:' + socket.gethostname(), 'DNS:localhost'] + ['IP:' + a for a in local_addresses()])
        old = os.umask(0o077)
        try:
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
                            '-keyout', str(key), '-out', str(cert), '-days', '3650', '-subj', '/CN=mesh-mission-control',
                            '-addext', 'subjectAltName=' + sans], check=True, capture_output=True)
        finally: os.umask(old)
    return cert, key

def fingerprint():
    der = ssl.PEM_cert_to_DER_cert(certificate()[0].read_text())
    digest = hashlib.sha256(der).hexdigest().upper()
    return ':'.join(digest[i:i + 2] for i in range(0, len(digest), 2))

def clean_host(raw):
    """Validate a host entry from the CLI or API. Names and addresses never begin with '-', so ssh cannot read them as options."""
    if not isinstance(raw, dict): raise ValueError('Host must be an object')
    name, address = str(raw.get('name', '')).strip(), str(raw.get('address', '')).strip()
    if not NAME_RE.match(name): raise ValueError('Name: letters, digits, . _ - (max 40)')
    if not ADDRESS_RE.match(address): raise ValueError('Address: an IP, hostname, or "local"')
    host = {'name': name, 'address': address}
    user = str(raw.get('user') or '').strip()
    if user:
        if not USER_RE.match(user): raise ValueError('Invalid user')
        host['user'] = user
    if raw.get('port') not in (None, ''):
        try: port = int(raw['port'])
        except (TypeError, ValueError): raise ValueError('Invalid port')
        if not 1 <= port <= 65535: raise ValueError('Invalid port')
        host['port'] = port
    key = str(raw.get('key') or '').strip()
    if key:
        if key.startswith('-') or len(key) > 4096 or '\0' in key: raise ValueError('Invalid key path')
        host['key'] = key
    return host

def load_hosts():
    path = private_dir() / 'hosts.json'
    try: raw = json.loads(path.read_text())['hosts']
    except FileNotFoundError: return []
    hosts, seen = [], set()
    for item in raw:
        host = clean_host(item)
        if host['name'] not in seen: seen.add(host['name']); hosts.append(host)
    return hosts

def save_hosts(hosts):
    path = private_dir() / 'hosts.json'
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump({'hosts': hosts}, f, indent=2); f.write('\n')
    os.replace(tmp, path)

def add_host(raw):
    host = clean_host(raw)
    hosts = [h for h in load_hosts() if h['name'] != host['name']] + [host]
    save_hosts(hosts)
    return host

def remove_host(name):
    hosts = load_hosts(); kept = [h for h in hosts if h['name'] != name]
    if len(kept) == len(hosts): raise KeyError(name)
    save_hosts(kept)
