"""Find machines that could be monitored, on the tailnet and on the local network. Only runs when asked."""
import concurrent.futures, ipaddress, json, re, socket, subprocess
import config

def tailnet():
    """Online peers from the local Tailscale client. Returns [] when Tailscale is absent or logged out."""
    try:
        data = json.loads(subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True, timeout=10, check=True).stdout)
    except (OSError, subprocess.SubprocessError, ValueError): return []
    found = []
    for peer in (data.get('Peer') or {}).values():
        ips = [ip for ip in peer.get('TailscaleIPs') or [] if '.' in ip]
        name = re.sub(r'[^A-Za-z0-9._-]', '-', peer.get('HostName') or '')[:40].strip('-.')
        # Phones and tablets cannot accept SSH logins, so they are not offered.
        if ips and name and (peer.get('OS') or '').lower() not in ('android', 'ios'): found.append({'name': name, 'address': ips[0], 'source': 'tailnet', 'os': peer.get('OS') or '', 'online': bool(peer.get('Online'))})
    return sorted(found, key=lambda c: (not c['online'], c['name']))

# VPN interfaces are added to the container and virtual ones the server never advertises.
SKIP_IFACES = config.SKIP_IFACES + ('tailscale', 'tun', 'utun', 'zt', 'wg')

def lan_networks():
    nets = []
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr', 'show'], capture_output=True, text=True, timeout=5).stdout
        pairs = [(ip, prefix) for iface, ip, prefix in re.findall(r'^\d+:\s+(\S+)\s+inet (\d+\.\d+\.\d+\.\d+)/(\d+)', out, re.M) if not iface.startswith(SKIP_IFACES)]
    except (OSError, subprocess.SubprocessError): pairs = []
    if not pairs:
        try:
            out = subprocess.run(['ifconfig'], capture_output=True, text=True, timeout=5).stdout
            pairs = [(ip, str(bin(int(mask, 16)).count('1'))) for ip, mask in re.findall(r'inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-f]+)', out)]
        except (OSError, subprocess.SubprocessError, ValueError): pairs = []
    for ip, prefix in pairs:
        addr = ipaddress.ip_address(ip)
        if not addr.is_private or addr.is_loopback or addr.is_link_local or ip.startswith('100.'): continue
        # Never scan more than a /24 around this machine.
        net = ipaddress.ip_network(f'{ip}/{max(24, int(prefix))}', strict=False)
        if net not in nets: nets.append(net)
    return nets

def _ssh_open(ip):
    try:
        with socket.create_connection((ip, 22), timeout=.5): pass
    except OSError: return None
    try: name = socket.gethostbyaddr(ip)[0].split('.')[0]
    except OSError: name = ''
    return ip, re.sub(r'[^A-Za-z0-9._-]', '-', name)[:40].strip('-.') or 'host-' + ip.replace('.', '-')

def lan():
    """Hosts on the local /24 networks that accept connections on the SSH port."""
    ips = [str(ip) for net in lan_networks() for ip in net.hosts()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
        hits = [h for h in pool.map(_ssh_open, ips) if h]
    return [{'name': name, 'address': ip, 'source': 'lan', 'os': '', 'online': True} for ip, name in hits]

def discover(use_lan=True, use_tailnet=True):
    found = (tailnet() if use_tailnet else []) + (lan() if use_lan else [])
    seen, unique = set(), []
    for item in found:
        if item['address'] not in seen: seen.add(item['address']); unique.append(item)
    return unique
