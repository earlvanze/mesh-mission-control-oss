// Connection and host management. Talks to the native bridge; the app never opens SSH itself.
const pending = new Map();
let nextId = 1;

window.meshNative = (id, status, body) => {
  const done = pending.get(id);
  if (!done) return;
  pending.delete(id);
  let text = '';
  try { text = body ? new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0))) : ''; } catch (error) { /* leave empty */ }
  done({status, ok: status >= 200 && status < 300, body, text});
};

function call(method, ...args) {
  return new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    window.MeshBridge[method](id, ...args);
  });
}

export const native = (verb, path, body = '') => call('request', verb, path, body);
export const config = () => { try { return JSON.parse(window.MeshBridge.config()); } catch (error) { return {server: '', paired: false, fingerprint: ''}; } };
const json = result => { try { return JSON.parse(result.text); } catch (error) { return {}; } };

const h = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  for (const child of children) el.append(child);
  return el;
};

export function initSettings({button, dialog, onChange}) {
  const body = dialog.querySelector('.dlgBody');
  let message = '';

  async function render() {
    body.replaceChildren();
    const cfg = config();
    const note = h('p', {className: 'dlgNote', textContent: message});
    body.append(h('h2', {textContent: 'Settings'}), note, connectionSection(cfg));
    if (cfg.paired) body.append(await hostsSection());
    body.append(h('button', {textContent: 'Close', onclick: () => dialog.close()}));
  }

  function connectionSection(cfg) {
    const server = h('input', {placeholder: 'Server address, e.g. 192.168.1.20 or 100.64.0.5', value: cfg.server || '', autocapitalize: 'none', spellcheck: false});
    const token = h('input', {placeholder: cfg.paired ? 'Token (leave blank to keep)' : 'Token from `mmc.py pair`', type: 'password', autocapitalize: 'none'});
    const found = h('div', {className: 'dlgList'});
    const trust = h('div', {className: 'dlgList'});
    const scan = h('button', {textContent: 'Find servers on this network', onclick: async () => {
      found.textContent = 'Scanning…';
      const servers = json(await call('scan')).servers || [];
      found.replaceChildren(...(servers.length ? servers.map(s => h('button', {textContent: s.name + ' · ' + s.address, onclick: () => { server.value = s.address; }})) : [h('span', {textContent: 'No servers found. Enter the address of the machine running mmc.py; for a tailnet use its 100.x address.'})]));
    }});
    const check = h('button', {textContent: cfg.paired ? 'Re-pair' : 'Check and pair', onclick: async () => {
      trust.textContent = 'Contacting…';
      const info = json(await call('inspect', server.value.trim()));
      if (!info.fingerprint) { trust.textContent = 'Could not reach a Mesh Mission Control server there.'; return; }
      trust.replaceChildren(
        h('p', {textContent: 'Certificate SHA-256 (must match what mmc.py pair prints):'}),
        h('code', {textContent: info.fingerprint}),
        h('button', {textContent: 'It matches. Save.', onclick: async () => {
          const saved = json(await call('save', server.value.trim(), token.value.trim(), info.fingerprint));
          if (!saved.ok) { trust.textContent = 'Not saved: ' + (saved.error || 'unknown error'); return; }
          message = 'Paired.'; await render(); onChange();
        }}));
    }});
    const list = [h('h3', {textContent: 'Connection'})];
    if (cfg.paired) list.push(h('p', {className: 'dlgNote', textContent: 'Paired with ' + cfg.server + ' · ' + cfg.fingerprint.slice(0, 23) + '…'}));
    list.push(server, token, h('div', {className: 'row'}, scan, check), found, trust);
    return h('section', {}, ...list);
  }

  async function hostsSection() {
    const hosts = json(await native('GET', '/api/hosts')).hosts || [];
    const section = h('section', {}, h('h3', {textContent: 'Hosts'}));
    const list = h('div', {className: 'dlgList'});
    const refresh = async text => { message = text || message; await render(); onChange(); };
    for (const host of hosts) {
      list.append(h('div', {className: 'row'},
        h('span', {textContent: host.name + ' · ' + (host.user ? host.user + '@' : '') + host.address}),
        h('button', {textContent: 'Remove', onclick: async () => { await native('DELETE', '/api/hosts/' + encodeURIComponent(host.name)); refresh('Removed ' + host.name + '.'); }})));
    }
    if (!hosts.length) list.append(h('span', {textContent: 'No hosts yet. Add one below or discover them.'}));
    const name = h('input', {placeholder: 'Name', autocapitalize: 'none'});
    const address = h('input', {placeholder: 'IP or hostname, or "local"', autocapitalize: 'none'});
    const user = h('input', {placeholder: 'SSH user (optional)', autocapitalize: 'none'});
    const add = (entry, text) => native('POST', '/api/hosts', JSON.stringify(entry)).then(r => r.ok ? refresh(text) : (message = json(r).error || 'Could not add host', render()));
    const found = h('div', {className: 'dlgList'});
    const discover = (lan, tailnet) => h('button', {textContent: lan ? 'Discover on LAN' : 'Discover on tailnet', onclick: async () => {
      found.textContent = 'Scanning…';
      const candidates = (json(await native('POST', '/api/discover', JSON.stringify({lan, tailnet}))).candidates || []).filter(c => !hosts.some(x => x.address === c.address));
      found.replaceChildren(...(candidates.length ? candidates.map(c => h('button', {textContent: 'Add ' + c.name + ' · ' + c.address + (c.os ? ' · ' + c.os : '') + (c.online ? '' : ' · offline'),
        onclick: () => add({name: c.name, address: c.address, user: user.value.trim()}, 'Added ' + c.name + '. It shows as unavailable until SSH login works.')})) : [h('span', {textContent: 'Nothing new found.'})]));
    }});
    section.append(list, h('div', {className: 'row'}, name, address, user,
      h('button', {textContent: 'Add host', onclick: () => add({name: name.value.trim(), address: address.value.trim(), user: user.value.trim()}, 'Added ' + name.value.trim() + '.')})),
      h('div', {className: 'row'}, discover(true, false), discover(false, true)), found);
    return section;
  }

  button.onclick = async () => { message = ''; await render(); dialog.showModal(); };
  return {open: button.onclick};
}
