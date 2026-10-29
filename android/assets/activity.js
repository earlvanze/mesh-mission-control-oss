// Flags come from live Codex status observations, not from session history.
export function unmonitoredCodexHosts(hosts, coverage) {
  const monitored = new Set((coverage || []).map(item => item.host));
  return hosts.filter(host => !monitored.has(host));
}
export function codexDaemonCoverage(hosts, coverage, selected = '') {
  const scope = selected ? hosts.filter(host => host === selected) : hosts;
  const reporting = scope.filter(host => (coverage || []).some(item => item.host === host && (item.status === 'ok' || item.status === 'partial'))).length;
  return reporting + '/' + scope.length + ' hosts report daemon status';
}
export function processSummary(observations) {
  return (observations || []).filter(o => o.status === 'ok').map(o => {
    const counts = Object.entries(o.counts || {}).filter(([, count]) => Number.isFinite(count) && count > 0);
    return counts.length ? o.host + ': ' + counts.map(([name,count]) => name + ' ' + count).join(', ') : '';
  }).filter(Boolean).join(' · ');
}
export function processTotal(hosts, observations, selected = '') {
  const scope = selected ? hosts.filter(host => host === selected) : hosts;
  let count = 0, reporting = 0, byRuntime = {};
  for (const host of scope) {
    const item = (observations || []).find(o => o.host === host);
    if (item?.status !== 'ok' || !item.counts || typeof item.counts !== 'object' || Array.isArray(item.counts)) continue;
    const values = Object.values(item.counts);
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) continue;
    count += values.reduce((sum, value) => sum + value, 0);
    for (const [runtime, value] of Object.entries(item.counts))
      byRuntime[runtime] = (byRuntime[runtime] || 0) + value;
    reporting++;
  }
  return {count, reporting, expected: scope.length, byRuntime};
}
// A relationship or lifecycle event is an observation, not proof of activity.
export function isSubagent(row) {
  return row.source === 'Claude subagent event' || (row.source === 'OpenClaw' && !!row.parentId) ||
    (typeof row.source === 'string' && row.source.startsWith('Codex') && !!row.parentId);
}
export function displayName(row) {
  const name = row.name || '';
  if (row.agentNickname && (!name || /^Codex session [0-9a-f]{8}$/i.test(name)))
    return row.agentNickname;
  return name || 'Untitled session';
}
export function parentRow(row, byId) {
  if (!row.parentId) return null;
  return byId.get(row.parentId) || byId.get('claude:' + row.host + ':' + row.parentId) || null;
}
export function parentLabel(row, byId) {
  if (!row.parentId) return '';
  const parent = parentRow(row, byId);
  return parent ? displayName(parent) : row.parentId;
}
export function flagged(row, host='') {
  return (row.liveObservations || []).some(o => (!host || o.host === host) && Array.isArray(o.flags) && o.flags.length > 0);
}
export function knownActive(row, host='') {
  if (row.status !== 'Running') return false;
  return (row.liveObservations || []).some(o => (!host || o.host === host) && o.status === 'active');
}

export function herdrState(row, state, host='') {
  return (row.herdrObservations || []).some(o => o.status === state && (!host || o.host === host));
}

// Prioritize actionable markers and keep each session associated with its host.
export function sceneHighlights(rows, host, limit=24) {
  const attention = rows.filter(row => flagged(row, host) || herdrState(row, 'blocked', host));
  const active = rows.filter(row => (knownActive(row, host) || herdrState(row, 'working', host)) && !attention.includes(row));
  return attention.concat(active).slice(0, limit).map(row => ({
    row, color: flagged(row, host) || herdrState(row, 'blocked', host) ? 0xff7777 : herdrState(row, 'working', host) && !knownActive(row, host) ? 0x76e8a9 : 0xffdd82,
    size: flagged(row, host) ? .15 : .12
  }));
}

// A matched Claude process indicates an open process, not an active turn.
export function processOpen(row, host='') {
  return row.source === 'Claude event' && row.processPresent === true && (!host || row.host === host);
}

export function codexFileOpen(row, host='') {
  return (row.codexFileObservations || []).some(o => !host || o.host === host);
}
export function codexEventProcesses(row, host='') {
  return [...new Set((row.codexEvents || []).filter(o => o.processPresent === true && (!host || o.host === host)).map(o => o.host).filter(Boolean))];
}

// The last event is historical; it may already have been resolved.
export function lastPermissionEvent(row, host='') {
  if (row.source === 'Claude event' && (!host || row.host === host) &&
      /(?:last event |Last event · )PermissionRequest$/.test(row.status || '')) return true;
  return (row.codexEvents || []).some(e => (!host || e.host === host) && e.event === 'PermissionRequest');
}

export function onHost(row, host='') {
  return !host || (row.herdrObservations || []).some(o => o.host === host) || row.host === host || (row.locations || []).includes(host) ||
    (row.liveObservations || []).some(o => o.host === host) || (row.codexEvents || []).some(o => o.host === host) || codexFileOpen(row, host);
}

export function locationDetails(row) {
  const details = [];
  for (const obs of row.herdrObservations || []) details.push('Herdr on ' + obs.host + ': ' + obs.status + ' (' + obs.runtime + ', pane ' + obs.paneId + ')');
  if (row.source === 'Codex' || row.source === 'Codex remote') {
    const locations = row.locations?.length ? row.locations : row.host ? [row.host] : [];
    if (locations.length) details.push('Inventory locations: ' + [...new Set(locations)].join(', '));
  }
  const live = [...new Set((row.liveObservations || []).map(o => o.host).filter(Boolean))];
  if (live.length) details.push('Live status hosts: ' + live.join(', '));
  const files = [...new Set((row.codexFileObservations || []).map(o => o.host).filter(Boolean))];
  if (files.length) details.push('Codex file observed on: ' + files.join(', '));
  for (const obs of row.codexFileObservations || [])
    if (obs.pids?.length) details.push('File held by Codex process on ' + obs.host + ': ' + obs.pids.join(', ') + ' (process may hold other sessions)');
  for (const event of row.codexEvents || []) {
    details.push('Last Codex event on ' + event.host + ': ' + event.event);
    if (event.processPresent) details.push('Event-associated Codex process present on ' + event.host + (Number.isSafeInteger(event.processPid) && event.processPid > 0 ? ': ' + event.processPid : '') + ' (may serve other sessions)');
  }
  if (row.source?.startsWith('Claude') && row.host) details.push('Event host: ' + row.host);
  return details.length ? details : ['Location: unknown'];
}

// A replicated session can be active on one host and idle or unobserved on another.
export function displayStatus(row, host='') {
  if (row.source === 'Claude event' || row.source === 'Claude subagent event') {
    const labels = {SessionStart:'Session started', UserPromptSubmit:'Prompt submitted',
      PermissionRequest:'Permission requested', Stop:'Stop event', SessionEnd:'Session ended',
      SubagentStart:'Subagent started', SubagentStop:'Subagent stopped'};
    return (row.status || 'Unknown').replace(/(last event |Last event · )(\w+)$/, (match, prefix, event) => prefix + (labels[event] || event));
  }
  if (!host || typeof row.source !== 'string' || !row.source.startsWith('Codex'))
    return row.status || 'Unknown';
  const observation = (row.liveObservations || []).find(o => o.host === host);
  if (!observation) {
    const event = (row.codexEvents || []).find(o => o.host === host);
    return event ? 'Last event · ' + event.event : 'Activity unverified on ' + host;
  }
  return observation.status === 'active' ? 'Running' : 'Loaded · ' + (observation.status || 'unknown');
}

// Bring actionable and confirmed activity ahead of process-only evidence.
export function compareSessions(a, b, host='') {
  return Number(herdrState(b,'blocked',host))-Number(herdrState(a,'blocked',host)) ||
    Number(flagged(b,host))-Number(flagged(a,host)) ||
    Number(herdrState(b,'working',host))-Number(herdrState(a,'working',host)) ||
    Number(knownActive(b,host))-Number(knownActive(a,host)) ||
    Number(processOpen(b,host))-Number(processOpen(a,host)) ||
    Number(codexFileOpen(b,host))-Number(codexFileOpen(a,host)) ||
    Number(codexEventProcesses(b,host).length>0)-Number(codexEventProcesses(a,host).length>0) ||
    (sessionTimestamp(b,host).time||0)-(sessionTimestamp(a,host).time||0);
}

// Session history's updated time is not the time a live status was checked.
export function sessionTimestamp(row, host='') {
  if (row.source === 'OpenClaw' && Number.isFinite(row.statusObservedAt) && row.statusObservedAt > 0)
    return {label: 'Status observed', time: row.statusObservedAt};
  const times = (row.liveObservations || [])
    .filter(o => (!host || o.host === host) && Number.isFinite(o.observedAt) && o.observedAt > 0)
    .map(o => o.observedAt);
  if (times.length) return {label: 'Status observed', time: Math.max(...times)};
  const herdr = (row.herdrObservations || []).filter(o => (!host || o.host === host) && Number.isFinite(o.observedAt) && o.observedAt > 0).map(o => o.observedAt);
  if (herdr.length) return {label: 'Herdr observed', time: Math.max(...herdr)};
  if (processOpen(row, host) && Number.isFinite(row.processObservedAt) && row.processObservedAt > 0)
    return {label: 'Process observed', time: row.processObservedAt};
  const files = (row.codexFileObservations || []).filter(o => (!host || o.host === host) && Number.isFinite(o.observedAt) && o.observedAt > 0).map(o => o.observedAt);
  if (files.length) return {label: 'Codex file observed', time: Math.max(...files)};
  const events = (row.codexEvents || []).filter(o => (!host || o.host === host) && Number.isFinite(o.observedAt) && o.observedAt > 0).map(o => o.observedAt);
  if (events.length) return {label: 'Last Codex event', time: Math.max(...events)};
  return {label: 'Record updated', time: row.updated};
}

// Use the tablet's elapsed wall time since its last successful response.
export function snapshotStale(lastSuccess, now, disconnected=false) {
  return disconnected || !lastSuccess || now - lastSuccess > 150000 || now < lastSuccess;
}

// Host capacity gauges. A missing or impossible reading is unknown, never zero.
export const GAUGES = [['cpu', 'CPU'], ['ram', 'RAM'], ['vram', 'VRAM'], ['gpu', 'GPU'], ['disk', 'Disk']];
const RESOURCE_MAX_AGE = 300;
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  const gib = n / 1073741824;
  return gib >= 1024 ? (gib / 1024).toFixed(1) + ' TiB' : gib >= 10 ? Math.round(gib) + ' GiB' : gib.toFixed(1) + ' GiB';
}
function usage(part) {
  if (!part || !Number.isFinite(part.used) || !Number.isFinite(part.total) || part.total <= 0 || part.used < 0 || part.used > part.total) return null;
  return part.used / part.total;
}
export function gaugeLevel(fraction) {
  return fraction === null || fraction === undefined ? 'unknown' : fraction >= .9 ? 'crit' : fraction >= .75 ? 'warn' : 'ok';
}
export function resourceGauges(res, now = Date.now() / 1000) {
  const valid = res && res.status === 'ok';
  const stale = !valid || !Number.isFinite(res.observedAt) || now - res.observedAt > RESOURCE_MAX_AGE;
  const cpu = valid && res.cpu && Number.isFinite(res.cpu.percent) && res.cpu.percent >= 0 && res.cpu.percent <= 100 ? res.cpu.percent / 100 : null;
  const make = (key, label, fraction, detail, hidden = false) => ({key, label, fraction, level: gaugeLevel(fraction), detail, stale, hidden});
  const gpu = valid && res.gpu && Number.isFinite(res.gpu.percent) && res.gpu.percent >= 0 && res.gpu.percent <= 100 ? res.gpu.percent / 100 : null;
  const mem = (key, label, part, missing) => {
    const f = valid ? usage(part) : null;
    return make(key, label, f, f === null ? missing : fmtBytes(part.used) + ' of ' + fmtBytes(part.total) + ' · ' + fmtBytes(part.total - part.used) + ' free');
  };
  return [
    make('cpu', 'CPU', cpu, cpu === null ? 'Not reported' : Math.round(cpu * 100) + '% of ' + res.cpu.cores + ' cores · load ' + res.cpu.load1),
    mem('ram', 'RAM', valid && res.ram, 'Not reported'),
    mem('vram', 'VRAM', valid && res.vram, valid && res.vram === null ? 'No discrete GPU reported' : 'Not reported'),
    // GPU core utilization is shown only on hosts that report it; its absence is not a zero.
    make('gpu', 'GPU', gpu, gpu === null ? 'No GPU utilization reported' : Math.round(gpu * 100) + '% core utilization · ' + res.gpu.gpus + (res.gpu.gpus === 1 ? ' GPU' : ' GPUs'), gpu === null),
    mem('disk', 'Disk', valid && res.disk, 'Not reported')
  ];
}
export function gaugeText(gauges) {
  return gauges.filter(g => !g.hidden).map(g => g.label + ' ' + (g.fraction === null ? '–' : Math.round(g.fraction * 100) + '%')).join(' · ');
}

// A host's standby state drives its animation: motion means data is being observed.
export function hostMode(rows, host, stale, live) {
  if (stale) return 'stale';
  if (!live || live.status === 'unavailable') return 'unknown';
  if (rows.some(r => flagged(r, host) || herdrState(r, 'blocked', host))) return 'attention';
  if (rows.some(r => knownActive(r, host) || herdrState(r, 'working', host))) return 'active';
  return 'idle';
}

// Subagent state is the last reported event, not proof of a running subagent.
export function moonState(row, host = '') {
  if (flagged(row, host) || herdrState(row, 'blocked', host)) return 'attention';
  if (knownActive(row, host) || herdrState(row, 'working', host)) return 'active';
  if (/Subagent ?Start/i.test(row.status || '')) return 'started';
  if (/Subagent ?Stop/i.test(row.status || '')) return 'stopped';
  return 'unknown';
}
function rootParent(row, byId, host) {
  let current = row;
  for (let hops = 0; hops < 5; hops++) {
    const parent = parentRow(current, byId);
    if (!parent || parent === row || !onHost(parent, host)) return current === row ? null : current;
    current = parent;
  }
  return null;
}

// Main agents are bodies orbiting their host; their subagents are moons.
const BODY_STYLE = {
  attention: {color: 0xff7777, size: .17, ring: 0}, working: {color: 0x76e8a9, size: .15, ring: 0},
  active: {color: 0xffdd82, size: .15, ring: 0}, parent: {color: 0x8da2b5, size: .12, ring: 1},
  process: {color: 0x62cfe6, size: .11, ring: 1}, file: {color: 0xb994ef, size: .11, ring: 2}
};
export function hostBodies(rows, host, limit = 24, maxMoons = 6) {
  const local = rows.filter(r => onHost(r, host));
  const byId = new Map(rows.map(r => [r.id, r]));
  const moons = new Map(), moonIds = new Set();
  for (const row of local) {
    if (!isSubagent(row)) continue;
    const root = rootParent(row, byId, host);
    if (!root) continue;
    moonIds.add(row.id);
    if (!moons.has(root.id)) moons.set(root.id, []);
    moons.get(root.id).push(row);
  }
  const seen = new Set(), bodies = [];
  const add = (row, kind) => {
    if (seen.has(row.id) || moonIds.has(row.id)) return;
    seen.add(row.id);
    const children = (moons.get(row.id) || []).slice(0, maxMoons).map(child => ({row: child, state: moonState(child, host)}));
    bodies.push({row, kind, ...BODY_STYLE[kind], moons: children, moonTotal: (moons.get(row.id) || []).length});
  };
  for (const row of local.filter(r => flagged(r, host) || herdrState(r, 'blocked', host))) add(row, 'attention');
  for (const row of local) if (knownActive(row, host)) add(row, 'active'); else if (herdrState(row, 'working', host)) add(row, 'working');
  for (const row of local) if (processOpen(row, host)) add(row, 'process');
  for (const row of local) if (codexFileOpen(row, host)) add(row, 'file');
  for (const row of local) if (moons.has(row.id)) add(row, 'parent');
  const perRing = [0, 0, 0];
  return bodies.filter(b => perRing[b.ring]++ < limit);
}

// Planet size grows with everything orbiting it (main agents plus their subagent moons).
// The floor keeps a quiet fleet from inflating a single moon.
export function planetScale(satellites, fleetMax) {
  const n = Number.isFinite(satellites) && satellites > 0 ? satellites : 0;
  return .8 + .5 * Math.sqrt(Math.min(1, n / Math.max(fleetMax || 0, 8)));
}

// Layout: every planet system gets exactly the room it needs, and planet orbits are spaced
// so no system reaches a neighbouring orbit. Units are scene units.
export const SUN_RADIUS = 1.9;
const GAUGE_OUTER = 1.03;
const BODY_RADIUS = .17, MOON_RADIUS = .07;
export const moonOrbit = k => .2 + .04 * k;
export function hostSystem(bodies, size) {
  const halfWidth = {};
  for (const b of bodies) {
    const need = b.moons.length ? moonOrbit(b.moons.length - 1) + MOON_RADIUS : BODY_RADIUS;
    halfWidth[b.ring] = Math.max(halfWidth[b.ring] || 0, need);
  }
  const lanes = {};
  let edge = GAUGE_OUTER * size + .3;
  for (const ring of Object.keys(halfWidth).map(Number).sort((a, b) => a - b)) {
    lanes[ring] = edge + halfWidth[ring];
    edge = lanes[ring] + halfWidth[ring] + .1;
  }
  return {lanes, radius: Object.keys(lanes).length ? edge : GAUGE_OUTER * size + .2};
}
// Every monitored host gets its own orbit.
export const OUTER_SCALE = .7;
export function beltRadius(innerRadii, innerSystems, outerSystems, gap = 1.2) {
  const last = innerRadii.length ? innerRadii[innerRadii.length - 1] + innerSystems[innerSystems.length - 1].radius : SUN_RADIUS + .6;
  return last + gap + Math.max(0, ...outerSystems.map(system => system.radius));
}
export function orbitRadii(systems, gap = .5, start = SUN_RADIUS + .6) {
  let edge = start;
  return systems.map(system => { const radius = edge + system.radius; edge = radius + system.radius + gap; return radius; });
}

// The lease names the gateway owner only; it does not show the gateway is healthy.
export function leaseState(lease, hosts, now = Date.now() / 1000) {
  if (!lease || lease.status !== 'ok' || lease.valid !== true || !hosts.includes(lease.owner)) return null;
  const elapsed = Number.isFinite(lease.observedAt) ? Math.max(0, now - lease.observedAt) : 0;
  return {owner: lease.owner, epoch: lease.epoch, remaining: Math.max(0, Math.round(lease.remaining - elapsed)), failedOver: lease.owner !== hosts[0]};
}

// Everything the 3D scene needs, derived from the latest snapshot.
export function sceneModel(hosts, data, stale, now = Date.now() / 1000) {
  const rows = data.sessions || [];
  const lease = leaseState(data.gatewayLease, hosts, now);
  const built = hosts.map(name => {
    const live = (data.liveCodex || []).find(x => x.host === name);
    const processes = (data.runtimeProcesses || []).find(x => x.host === name);
    const gauges = resourceGauges((data.hostResources || []).find(x => x.host === name), now);
    const bodies = hostBodies(rows, name);
    return {name, mode: hostMode(rows, name, stale, live), gauges, bodies, lease: lease && lease.owner === name ? lease : null,
      counts: {active: rows.filter(r => knownActive(r, name)).length, flagged: rows.filter(r => flagged(r, name)).length,
        claude: rows.filter(r => processOpen(r, name)).length, files: rows.filter(r => codexFileOpen(r, name)).length,
        moons: bodies.reduce((n, b) => n + b.moonTotal, 0),
        satellites: bodies.length + bodies.reduce((n, b) => n + b.moonTotal, 0),
        processes: processes && processes.status === 'ok' ? Object.values(processes.counts || {}).reduce((s, n) => s + (Number.isSafeInteger(n) && n > 0 ? n : 0), 0) : null}};
  });
  const fleetMax = Math.max(0, ...built.map(h => h.counts.satellites));
  return built.map(h => ({...h, scale: planetScale(h.counts.satellites, fleetMax)}));
}

// Process presence is not activity, so an outer host is never shown as active.
const RUNTIME_COLORS = {Claude: 0x62cfe6, Codex: 0xb994ef, Gemini: 0x7aa2ff, OpenCode: 0xf3c578, Hermes: 0xf08fb0, Pi: 0xe6e08a, ZCode: 0x8fe0a0,
  DeepSeek: 0x5f8cff, Aider: 0x9bd16b, Goose: 0xd9b38c, Amp: 0xff8a6b, Cursor: 0xc7c7d9, 'Qwen Code': 0xa58bff, Kimi: 0x6bd6ff, Crush: 0xff7fc8,
  Droid: 0xffa24d, Copilot: 0x9aa8ff, Cline: 0x8de6d2, Kilo: 0xf0e04d, OpenHands: 0xffd0a0, Forge: 0xff9f7a, Plandex: 0x7ad3a2, Augment: 0x7fd0ff,
  Junie: 0xe08fff, Grok: 0xd0d6dd, Vibe: 0xff9a4d};
export function outerModel(data, stale, now = Date.now() / 1000, maxBodies = 12) {
  return (data.outerHosts || []).map(item => {
    const gauges = resourceGauges(item, now);
    const fresh = item.status === 'ok' && Number.isFinite(item.observedAt) && now - item.observedAt <= RESOURCE_MAX_AGE;
    const found = item.processes && item.processes.status === 'ok' && Array.isArray(item.processes.processes) ? item.processes.processes : [];
    // Interleave tools so a crowd of one tool cannot hide the others behind the moon cap.
    const groups = new Map();
    for (const p of found) { if (!groups.has(p.runtime)) groups.set(p.runtime, []); groups.get(p.runtime).push(p); }
    const mixed = [];
    for (let i = 0; mixed.length < found.length; i++) for (const list of groups.values()) if (i < list.length) mixed.push(list[i]);
    const bodies = mixed.slice(0, maxBodies).map(p => ({
      row: {id: 'process:' + item.host + ':' + p.pid, name: p.runtime + ' process #' + p.pid, source: 'Process', status: 'Process present', host: item.host,
        target: p.cwd || '', updated: item.processes.observedAt},
      kind: 'process', color: RUNTIME_COLORS[p.runtime] || 0x62cfe6, size: .11, ring: 0, moons: [], moonTotal: 0}));
    return {name: item.host, outer: true, reason: item.status === 'ok' ? '' : String(item.reason || '').slice(0, 200), mode: stale ? 'stale' : fresh ? 'idle' : 'unknown', gauges, bodies, lease: null, scale: OUTER_SCALE,
      counts: {active: 0, flagged: 0, claude: 0, files: 0, moons: 0, satellites: found.length, extra: Math.max(0, found.length - bodies.length),
        processes: item.processes && item.processes.status === 'ok' ? found.length : null, byRuntime: item.processes && item.processes.counts || {}}};
  });
}

// Camera helpers: pinch scales zoom by the change in finger distance.
export function clampZoom(zoom, min = .4, max = 4) {
  return Number.isFinite(zoom) ? Math.min(max, Math.max(min, zoom)) : 1;
}
export function pinchZoom(startZoom, startDistance, distance) {
  return startDistance > 0 && distance > 0 ? clampZoom(startZoom * distance / startDistance) : clampZoom(startZoom);
}
