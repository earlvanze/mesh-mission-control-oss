import * as THREE from './three.module.js';
import {clampZoom, pinchZoom, gaugeText, hostSystem, orbitRadii, moonOrbit, SUN_RADIUS} from './activity.js';

// Solar system: the collector is the sun, each host is a planet, main agents orbit
// their host and subagents orbit their main agent as moons. Motion only runs while
// data is fresh, so a frozen system means stale data.
const START_ANGLES = [.5, 1.9, 3.3, 4.5, 5.6];
const PLANET_RADIUS = .6;
const GAUGE_RADII = [.76, .85, .94, 1.03, 1.12];
const INCLINATION = .6;
const GAUGE_COLORS = {cpu: 0x5ec8ff, ram: 0xb994ef, vram: 0xffa95e, gpu: 0xff6bd6, disk: 0x62d6a6};
const LEVEL_COLORS = {warn: 0xf3c578, crit: 0xff6b6b};
const MOON_COLORS = {attention: 0xff7777, active: 0xffdd82, started: 0x7fe3d4, stopped: 0x5b6b78, unknown: 0xa7b4d6};
const HALO = {attention: [0xff5a5a, .5, 5], active: [0x6fe3d0, .32, 2.2], idle: [0x6fd6c8, .16, .8], unknown: [0x6c7b88, .05, .4], stale: [0x6c7b88, .03, 0]};
const TONES = {ok: 0x42bba4, bad: 0xb75855, '': 0xb88941};
const LEVEL_CSS = {ok: '#a6e3d4', warn: '#f3c578', crit: '#ff8a8a', unknown: '#7f93a2'};
const LETTERS = {cpu: 'C', ram: 'R', vram: 'V', gpu: 'G', disk: 'D'};

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(.35, 'rgba(255,255,255,.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Banded, blotchy surface so rotation is visible; the tint comes from the material color.
function planetTexture(seed) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  let state = seed * 9301 + 49297;
  const random = () => (state = (state * 9301 + 49297) % 233280) / 233280;
  g.fillStyle = 'rgb(200,200,200)';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 16; i++) {
    const x = random() * 256, y = 14 + random() * 100, r = 12 + random() * 22, v = i % 3 === 0 ? 255 : 30;
    g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',.8)';
    for (const dx of [-256, 0, 256]) { g.beginPath(); g.ellipse(x + dx, y, r * 1.5, r, 0, 0, Math.PI * 2); g.fill(); }
  }
  const texture = new THREE.CanvasTexture(c);
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

function orbitLine(radius, color, opacity, segments = 128, inclination = 0) {
  const points = [];
  for (let i = 0; i < segments; i++) {
    const a = i / segments * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * Math.sin(inclination), Math.sin(a) * radius * Math.cos(inclination)));
  }
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({color, transparent: true, opacity}));
}

export function createWorld(canvas, handlers) {
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, .1, 400);
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sunLight = new THREE.PointLight(0xfff0cc, 14, 0, 1);
  scene.add(sunLight);
  const glow = glowTexture();
  const bodyGeometry = new Map(), materials = new Map();
  const geometryFor = size => { if (!bodyGeometry.has(size)) bodyGeometry.set(size, new THREE.SphereGeometry(size, 14, 10)); return bodyGeometry.get(size); };
  const materialFor = (color, dim) => {
    const key = color + ':' + dim;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({color, emissive: color, emissiveIntensity: .7, roughness: .4, transparent: dim, opacity: dim ? .3 : 1}));
    return materials.get(key);
  };

  // Background stars twinkle slowly.
  const starPositions = new Float32Array(900);
  for (let i = 0; i < 300; i++) {
    const r = 70 + Math.random() * 40, theta = Math.random() * Math.PI * 2, phi = Math.acos(2 * Math.random() - 1);
    starPositions.set([r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)], i * 3);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({color: 0xbfd6e8, size: .5, transparent: true, opacity: .6, depthWrite: false}));
  scene.add(stars);

  // Sun: pulses on every successful refresh, then dims when the link goes stale.
  const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 40, 28), new THREE.MeshBasicMaterial({color: 0xffc766}));
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({map: glow, color: 0xffb84d, transparent: true, opacity: .6, blending: THREE.AdditiveBlending, depthWrite: false}));
  sunGlow.scale.set(11.5, 11.5, 1);
  scene.add(sun, sunGlow);
  const wave = new THREE.Mesh(new THREE.RingGeometry(.97, 1, 96), new THREE.MeshBasicMaterial({color: 0xffd78a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false}));
  wave.rotation.x = -Math.PI / 2;
  wave.visible = false;
  scene.add(wave);

  // Lease beam: a tether from the sun to the gateway lease holder, with pulses running outward.
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, 1, 8, 1, true), new THREE.MeshBasicMaterial({color: 0xffd36b, transparent: true, opacity: .55, depthWrite: false, blending: THREE.AdditiveBlending}));
  beam.visible = false;
  const beamPulses = [0, 1, 2, 3].map(() => new THREE.Sprite(new THREE.SpriteMaterial({map: glow, color: 0xffe9a8, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false})));
  beamPulses.forEach(p => { p.scale.set(.7, .7, 1); p.visible = false; });
  scene.add(beam, ...beamPulses);
  let leaseHost = '', leaseFailedOver = false;
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3();

  const hosts = new Map();
  const bodiesRoot = new THREE.Group();
  scene.add(bodiesRoot);
  let link = 'down', clock = 0, flare = 0, waveAge = Infinity, selected = '', model = [], stale = true;

  function hostObject(name, index, outerIndex = -1, outerCount = 0) {
    if (hosts.has(name)) return hosts.get(name);
    const group = new THREE.Group();
    const texture = planetTexture(index + 1);
    const planet = new THREE.Mesh(new THREE.SphereGeometry(PLANET_RADIUS, 40, 28), new THREE.MeshStandardMaterial({color: TONES[''], map: texture, roughness: .5, metalness: .2, emissive: TONES[''], emissiveMap: texture, emissiveIntensity: .1}));
    planet.userData.host = name;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({map: glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}));
    halo.scale.set(4.2, 4.2, 1);
    const gauges = new THREE.Group();
    const arcs = GAUGE_RADII.map((radius, i) => {
      const track = new THREE.Mesh(new THREE.TorusGeometry(radius, .03, 6, 64), new THREE.MeshBasicMaterial({color: 0x2c4352, transparent: true, opacity: .55}));
      const arc = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({color: 0x5ec8ff, side: THREE.DoubleSide}));
      arc.userData = {shown: 0, target: 0, radius, track};
      arc.rotation.z = Math.PI / 2; arc.scale.x = -1;
      gauges.add(track, arc);
      return arc;
    });
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512; labelCanvas.height = 160;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({map: new THREE.CanvasTexture(labelCanvas), transparent: true, depthTest: false}));
    label.renderOrder = 1; label.scale.set(7, 2.19, 1); label.position.set(0, -2.7, 0);
    const bodies = new THREE.Group();
    group.add(planet, halo, gauges, label, bodies);
    scene.add(group);
    const orbit = orbitLine(1, 0x365769, .5);
    scene.add(orbit);
    const rings = [0, 1, 2].map(() => { const l = orbitLine(1, 0x2f4756, .0, 64, INCLINATION); group.add(l); return l; });
    const object = {name, index, outer: outerIndex >= 0, outerIndex, size: 1, sizeTarget: 1, angle: outerIndex >= 0 ? .3 + outerIndex * Math.PI * 2 / Math.max(1, outerCount) : START_ANGLES[index], orbitRadius: 0, orbitTarget: 0, sysRadius: 0, lane: [0, 0, 0], laneTarget: [0, 0, 0], owned: [], placed: false, group, planet, halo, gauges, arcs, label, labelCanvas, bodies, orbit, rings, mode: 'stale', flash: 0, cpu: 0, tone: ''};
    hosts.set(name, object);
    return object;
  }

  function drawLabel(h, host) {
    const c = h.labelCanvas.getContext('2d');
    c.clearRect(0, 0, 512, 160);
    c.textAlign = 'center';
    c.font = 'bold 34px sans-serif'; c.fillStyle = '#d8e8ef';
    c.fillText(host.name, 256, 40);
    // One coloured segment per gauge so a saturated resource stands out at a glance.
    c.font = 'bold 27px sans-serif';
    const shown = host.gauges.filter(g => !g.hidden);
    const texts = shown.map(g => LETTERS[g.key] + ' ' + (g.fraction === null ? '–' : Math.round(g.fraction * 100) + '%'));
    const gap = 22, total = texts.reduce((sum, text) => sum + c.measureText(text).width, 0) + gap * (texts.length - 1);
    let x = Math.max(4, 256 - total / 2);
    shown.forEach((g, i) => {
      c.fillStyle = stale || g.stale ? LEVEL_CSS.unknown : LEVEL_CSS[g.level];
      c.textAlign = 'left'; c.fillText(texts[i], x, 80); x += c.measureText(texts[i]).width + gap;
    });
    c.textAlign = 'center'; c.font = '24px sans-serif'; c.fillStyle = stale ? '#8196a5' : '#a6c8c4';
    const n = host.counts;
    if (host.outer) {
      c.fillText(stale ? 'Data stale' : n.processes === null ? 'Processes unknown' : n.processes + (n.processes === 1 ? ' CLI process' : ' CLI processes') + (n.extra ? ' · ' + n.extra + ' not shown' : ''), 256, 118);
      
      h.label.material.map.needsUpdate = true;
      return;
    }
    c.fillText(stale ? 'Data stale' : host.mode === 'unknown' ? 'Activity unknown' : n.active + ' active · ' + n.flagged + ' flags' + (n.moons ? ' · ' + n.moons + (n.moons === 1 ? ' subagent' : ' subagents') : ''), 256, 118);
    if (host.lease && !stale) {
      c.font = 'bold 22px sans-serif'; c.fillStyle = host.lease.failedOver ? '#ff9f43' : '#ffd36b';
      c.fillText('gateway lease · epoch ' + host.lease.epoch + (host.lease.failedOver ? ' · failed over' : ''), 256, 150);
    }
    h.label.material.map.needsUpdate = true;
  }

  function buildBodies(h, host) {
    while (h.bodies.children.length) h.bodies.remove(h.bodies.children[0]);
    h.owned.forEach(m => m.dispose());
    h.owned = [];
    // Status shows as a brightness pulse; size always means size. Pulsing meshes get their own material.
    const pulsing = (mesh, rate, amp) => {
      mesh.material = mesh.material.clone();
      h.owned.push(mesh.material);
      mesh.userData.pulse = {rate, amp, phase: Math.random() * 6};
    };
    const perRing = [0, 0, 0];
    h.rings.forEach((r, i) => { r.material.opacity = 0; });
    for (const body of host.bodies) {
      const index = perRing[body.ring]++;
      const anchor = new THREE.Group();
      const mesh = new THREE.Mesh(geometryFor(body.size), materialFor(body.color, stale));
      mesh.userData = {host: host.name, session: body.row.id};
      if (!stale && body.kind === 'attention') pulsing(mesh, 9, .7);
      else if (!stale && (body.kind === 'active' || body.kind === 'working')) pulsing(mesh, 3.5, .45);
      anchor.add(mesh);
      anchor.userData = {ring: body.ring, slot: index, kind: body.kind, mesh, moons: []};
      body.moons.forEach((moon, k) => {
        const m = new THREE.Mesh(geometryFor(.07), materialFor(MOON_COLORS[moon.state], stale || moon.state === 'stopped'));
        m.userData = {host: host.name, session: moon.row.id, orbit: moonOrbit(k), phase: k * 2.4, state: moon.state};
        if (!stale && moon.state === 'attention') pulsing(m, 9, .7);
        else if (!stale && (moon.state === 'started' || moon.state === 'active')) pulsing(m, 4, .4);
        anchor.add(m);
        anchor.userData.moons.push(m);
      });
      h.bodies.add(anchor);
      h.rings[body.ring].material.opacity = stale ? .08 : .22;
    }
    h.bodies.children.forEach(a => { a.userData.count = perRing[a.userData.ring]; });
  }

  function sync(next) {
    model = next.hosts;
    stale = next.stale;
    link = next.link;
    const outerCount = model.filter(host => host.outer).length;
    let outerSeen = 0;
    model.forEach((host, i) => {
      const h = hostObject(host.name, i, host.outer ? outerSeen++ : -1, outerCount);
      h.mode = host.mode; h.tone = next.tones?.[host.name] || '';
      const color = TONES[h.tone] ?? TONES[''];
      h.planet.material.color.setHex(color); h.planet.material.emissive.setHex(color);
      h.cpu = host.gauges[0].fraction ?? 0;
      h.sizeTarget = host.scale || 1;
      host.gauges.forEach((g, k) => {
        const arc = h.arcs[k];
        arc.userData.target = g.fraction ?? 0;
        arc.visible = g.fraction !== null;
        arc.userData.track.visible = !g.hidden;
        arc.material.color.setHex(g.level === 'ok' || g.level === 'unknown' ? GAUGE_COLORS[g.key] : LEVEL_COLORS[g.level]);
        arc.material.transparent = stale || g.stale; arc.material.opacity = stale || g.stale ? .3 : 1;
      });
      drawLabel(h, host);
      buildBodies(h, host);
    });
    // Give each system the room it needs, then space the planet orbits to clear them.
    const systems = model.map(host => hostSystem(host.bodies, host.scale || 1));
    const innerIndexes = model.map((host, i) => i).filter(i => !model[i].outer), outerIndexes = model.map((host, i) => i).filter(i => model[i].outer);
    const innerSystems = innerIndexes.map(i => systems[i]), outerSystems = outerIndexes.map(i => systems[i]);
    const innerRadii = orbitRadii(innerSystems);
    // Outer hosts get their own orbits beyond the mesh, spaced like the inner ones.
    const innerEdge = innerRadii.length ? innerRadii[innerRadii.length - 1] + innerSystems[innerSystems.length - 1].radius : SUN_RADIUS + .6;
    const outerRadii = orbitRadii(outerSystems, .5, innerEdge + 1.2);
    model.forEach((host, i) => {
      const h = hosts.get(host.name);
      h.sysRadius = systems[i].radius;
      h.orbitTarget = host.outer ? outerRadii[outerIndexes.indexOf(i)] : innerRadii[innerIndexes.indexOf(i)];
      h.laneTarget = [0, 1, 2].map(ring => systems[i].lanes[ring] || 0);
      if (!h.placed) { h.placed = true; h.orbitRadius = h.orbitTarget; h.lane = h.laneTarget.slice(); }
    });
    sunLight.intensity = stale ? 5 : 14;
    const holder = model.find(h => h.lease);
    leaseHost = holder ? holder.name : '';
    leaseFailedOver = !!holder?.lease.failedOver;
  }

  const view = {yaw: 0, pitch: .5, zoom: 1, zoomTarget: 1, target: new THREE.Vector3(), goal: new THREE.Vector3(), pan: new THREE.Vector3(), focus: ''};
  let width = 1, height = 1;
  // Fit the tilted outermost orbit: its near side sits closer to the camera, so the vertical extent dominates.
  let extent = 16;
  const fitDistance = () => {
    const t = Math.tan(camera.fov * Math.PI / 360), aspect = width / height;
    const vertical = extent * (Math.cos(view.pitch) + Math.sin(view.pitch) / t), horizontal = extent / (t * aspect);
    return Math.max(24, 1.18 * Math.max(vertical, horizontal));
  };
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const world = new THREE.Vector3();
  // Planets travel at a constant linear speed; orbit radii ease when a system grows or shrinks.
  function planetPosition(h, dt, animate) {
    h.orbitRadius += (h.orbitTarget - h.orbitRadius) * Math.min(1, dt * 2);
    for (let ring = 0; ring < 3; ring++) h.lane[ring] += (h.laneTarget[ring] - h.lane[ring]) * Math.min(1, dt * 3);
    if (animate) h.angle += dt * .35 / Math.max(1, h.orbitRadius);
    h.group.position.set(Math.cos(h.angle) * h.orbitRadius, 0, Math.sin(h.angle) * h.orbitRadius);
    h.orbit.scale.setScalar(Math.max(.01, h.orbitRadius));
    h.rings.forEach((r, ring) => r.scale.setScalar(Math.max(.01, h.lane[ring])));
  }

  const glowPulse = (mesh, animate) => {
    const p = mesh.userData.pulse;
    if (p) mesh.material.emissiveIntensity = animate ? .9 + Math.sin(clock * p.rate + p.phase) * p.amp : .7;
  };

  function frame(dt) {
    // Motion is the status signal, so the OS animation setting is not honored; only stale data freezes it.
    if (!stale) clock += dt;
    const animate = !stale;
    flare = Math.max(0, flare - dt * 1.2);
    waveAge += dt;
    const live = link === 'live';
    const beat = animate ? 1 + Math.sin(clock * 1.6) * .03 + flare * .18 : 1;
    sun.scale.setScalar(beat);
    sun.material.color.setHex(live ? 0xffc766 : link === 'stale' ? 0x9a7f55 : 0x8a5a55);
    sunGlow.material.color.setHex(live ? 0xffb84d : 0x8a6f50);
    sunGlow.material.opacity = live ? .5 + flare * .4 + (animate ? Math.sin(clock * 1.6) * .06 : 0) : .18;
    sunGlow.scale.setScalar(11.5 * (1 + flare * .25));
    wave.visible = waveAge < 4.2;
    if (wave.visible) {
      const radius = SUN_RADIUS * 1.05 + waveAge * 6;
      wave.scale.setScalar(radius);
      wave.material.opacity = .45 * (1 - waveAge / 4.2);
    }
    stars.material.opacity = animate ? .55 + Math.sin(clock * .7) * .12 : .35;
    if (animate) stars.rotation.y += dt * .002;

    for (const h of hosts.values()) {
      planetPosition(h, dt, animate);
      extent = Math.max(1, ...[...hosts.values()].map(o => o.orbitRadius + o.sysRadius));
      const [haloColor, haloOpacity, haloRate] = HALO[stale ? 'stale' : h.mode] || HALO.unknown;
      h.halo.material.color.setHex(haloColor);
      if (wave.visible && !stale && h.mode !== 'unknown' && Math.abs(waveAge * 6 + SUN_RADIUS * 1.05 - h.orbitRadius) < .9) h.flash = 1;
      h.flash = Math.max(0, h.flash - dt * 1.5);
      h.halo.material.opacity = haloOpacity * (1 + (animate && haloRate ? Math.sin(clock * haloRate * 2) * .45 : 0)) + h.flash * .4;
      h.planet.rotation.y += animate ? dt * (.5 + h.cpu * 2.5) : 0;
      h.planet.material.emissiveIntensity = .08 + h.cpu * .5 + h.flash * .3;
      const focused = h.name === view.focus || h.name === selected;
      // Planet size follows the number of satellites; the whole planet system scales together.
      h.size += (h.sizeTarget - h.size) * Math.min(1, dt * 3);
      const focusScale = h.planet.userData.focusScale = (h.planet.userData.focusScale || 1) + ((focused ? 1.2 : 1) - (h.planet.userData.focusScale || 1)) * Math.min(1, dt * 8);
      h.planet.scale.setScalar(h.size * focusScale);
      h.gauges.scale.setScalar(h.size);
      h.halo.scale.setScalar(4.2 * h.size);
      h.orbit.material.opacity = focused ? .9 : h.outer ? .3 : .45;
      h.orbit.material.color.setHex(focused ? 0x73c7bd : 0x365769);
      // Gauge arcs ease to their value; they always face the camera.
      h.gauges.quaternion.copy(camera.quaternion);
      for (const arc of h.arcs) {
        const u = arc.userData;
        if (Math.abs(u.shown - u.target) > .002) {
          u.shown += (u.target - u.shown) * Math.min(1, dt * 4);
          arc.geometry.dispose();
          const f = Math.max(.01, u.shown);
          arc.geometry = new THREE.TorusGeometry(u.radius, .042, 6, Math.max(4, Math.ceil(64 * f)), f * Math.PI * 2);
        }
      }
      // Main agents orbit the planet; subagents orbit their main agent.
      for (const anchor of h.bodies.children) {
        const d = anchor.userData, base = d.slot * Math.PI * 2 / Math.max(1, d.count);
        const a = base + clock * (.9 - d.ring * .2), r = h.lane[d.ring];
        anchor.position.set(Math.cos(a) * r, Math.sin(a) * r * Math.sin(INCLINATION), Math.sin(a) * r * Math.cos(INCLINATION));
        glowPulse(d.mesh, animate);
        for (const m of d.moons) {
          const o = m.userData, b = o.phase + clock * 2.4;
          m.position.set(Math.cos(b) * o.orbit, Math.sin(b) * o.orbit * .5, Math.sin(b) * o.orbit * .86);
          glowPulse(m, animate);
        }
      }
    }

    const holderObject = leaseHost && !stale ? hosts.get(leaseHost) : null;
    beam.visible = !!holderObject;
    beamPulses.forEach(p => { p.visible = !!holderObject; });
    if (holderObject) {
      const end = holderObject.group.position, length = end.length();
      direction.copy(end).normalize();
      beam.position.copy(end).multiplyScalar(.5);
      beam.scale.set(1, Math.max(.01, length), 1);
      beam.quaternion.setFromUnitVectors(up, direction);
      const color = leaseFailedOver ? 0xff9f43 : 0xffd36b;
      beam.material.color.setHex(color);
      beam.material.opacity = .45 + (animate ? Math.sin(clock * 3) * .12 : 0);
      beamPulses.forEach((p, i) => {
        const t = (clock * .5 + i / beamPulses.length) % 1;
        p.position.copy(end).multiplyScalar(.1 + t * .8);
        p.material.color.setHex(leaseFailedOver ? 0xffc27a : 0xffe9a8);
        p.material.opacity = Math.sin(t * Math.PI) * .9;
      });
    }

    // Camera: orbit around a target that follows the focused planet.
    const focusHost = hosts.get(view.focus);
    view.goal.copy(focusHost ? focusHost.group.position : world.set(0, 0, 0)).add(view.pan);
    view.target.lerp(view.goal, Math.min(1, dt * 4));
    view.zoom += (view.zoomTarget - view.zoom) * Math.min(1, dt * 8);
    const distance = fitDistance() / view.zoom;
    camera.position.set(view.target.x + Math.sin(view.yaw) * Math.cos(view.pitch) * distance, view.target.y + Math.sin(view.pitch) * distance, view.target.z + Math.cos(view.yaw) * Math.cos(view.pitch) * distance);
    camera.lookAt(view.target);
    // Labels keep a constant on-screen size however far the camera has to pull back.
    const forward = camera.getWorldDirection(direction);
    for (const h of hosts.values()) {
      const k = Math.max(.2, h.group.position.clone().sub(camera.position).dot(forward)) / 24;
      h.label.scale.set(7 * k, 2.19 * k, 1);
      h.label.position.y = -(1.03 * h.size + .3) - 1.1 * k;
    }
    renderer.render(scene, camera);
  }

  // Idle scenes redraw at 24 fps to save battery; interaction and camera moves run at full rate.
  let last = performance.now(), interacting = false, running = true;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!running || document.hidden) { last = now; return; }
    const moving = interacting || Math.abs(view.zoomTarget - view.zoom) > .002 || view.target.distanceToSquared(view.goal) > .0004;
    if (!moving && now - last < 41) return;
    const dt = Math.min(.25, (now - last) / 1000);
    last = now;
    frame(dt);
  }
  requestAnimationFrame(loop);
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; });
  canvas.addEventListener('webglcontextrestored', () => { running = true; last = performance.now(); });

  // Hit testing uses screen distance so small moons stay tappable at any zoom.
  const projected = new THREE.Vector3();
  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), px = clientX - r.left, py = clientY - r.top;
    const screen = obj => { obj.getWorldPosition(projected); projected.project(camera); return projected.z > 1 ? null : {x: (projected.x + 1) / 2 * r.width, y: (1 - projected.y) / 2 * r.height}; };
    let best = null, bestDistance = 24;
    for (const h of hosts.values()) for (const anchor of h.bodies.children) for (const obj of [...anchor.userData.moons, anchor.userData.mesh]) {
      const p = screen(obj);
      if (!p) continue;
      const d = Math.hypot(p.x - px, p.y - py) - (obj.userData.orbit ? 4 : 0);
      if (d < bestDistance) { best = {session: obj.userData.session, host: obj.userData.host}; bestDistance = d; }
    }
    if (best) return best;
    let nearest = null, nearestDistance = Infinity;
    for (const h of hosts.values()) {
      const p = screen(h.planet);
      if (!p) continue;
      h.planet.getWorldPosition(projected);
      const edge = projected.clone().add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(PLANET_RADIUS * 1.5 * h.size)).project(camera);
      const radius = Math.max(26, Math.abs(edge.x - projected.clone().project(camera).x) / 2 * r.width);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < radius && d < nearestDistance) { nearest = {host: h.name}; nearestDistance = d; }
    }
    return nearest;
  }

  // One finger rotates, two fingers pinch to zoom, slide sideways to pan and up/down to tilt, wheel zooms, double-tap resets.
  const pointers = new Map();
  let gesture = null, lastTap = 0;
  const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const midpoint = () => { const [a, b] = [...pointers.values()]; return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}; };
  // Two-finger sideways drag pans in the screen plane; the offset is limited so the scene cannot be lost.
  const right = new THREE.Vector3(), upAxis = new THREE.Vector3();
  function panBy(dx, dy) {
    const perPixel = 2 * camera.position.distanceTo(view.target) * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, height);
    right.setFromMatrixColumn(camera.matrixWorld, 0); upAxis.setFromMatrixColumn(camera.matrixWorld, 1);
    view.pan.addScaledVector(right, -dx * perPixel).addScaledVector(upAxis, dy * perPixel);
    view.pan.clampLength(0, extent * 1.2);
  }
  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch (error) { /* pointer already gone */ }
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    interacting = true;
    gesture = pointers.size === 2 ? {kind: 'pinch', distance: spread(), zoom: view.zoomTarget, mid: midpoint(), moved: true}
      : {kind: 'drag', x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, moved: false, at: performance.now()};
  });
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      view.zoomTarget = pinchZoom(gesture.zoom, gesture.distance, spread());
      const mid = midpoint();
      panBy(mid.x - gesture.mid.x, 0);
      view.pitch = Math.min(1.35, Math.max(.12, view.pitch + (mid.y - gesture.mid.y) * .006));
      gesture.mid = mid;
    } else if (gesture.kind === 'drag') {
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 12) gesture.moved = true;
      if (gesture.moved) {
        view.yaw = gesture.yaw - (e.clientX - gesture.x) * .008;
        view.pitch = Math.min(1.35, Math.max(.12, gesture.pitch + (e.clientY - gesture.y) * .006));
      }
    }
  });
  const release = e => {
    if (!pointers.delete(e.pointerId)) return;
    const done = gesture;
    if (pointers.size === 1) {
      // Pinch ended with a finger still down: continue as a drag from here.
      const [p] = [...pointers.values()];
      gesture = {kind: 'drag', x: p.x, y: p.y, yaw: view.yaw, pitch: view.pitch, moved: true, at: 0};
    } else if (pointers.size === 0) {
      gesture = null; interacting = false;
      if (done?.kind === 'drag' && !done.moved && e.type === 'pointerup' && performance.now() - done.at < 600) {
        const now = performance.now(), hit = pick(e.clientX, e.clientY);
        if (!hit && now - lastTap < 320) { view.yaw = 0; view.pitch = .5; view.zoomTarget = 1; view.pan.set(0, 0, 0); handlers.onReset?.(); }
        else if (!hit) handlers.onBackground?.();
        else if (hit.session) handlers.onSession?.(hit.host, hit.session);
        else handlers.onHost?.(hit.host);
        lastTap = now;
      }
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', e => { e.preventDefault(); view.zoomTarget = clampZoom(view.zoomTarget * Math.exp(-e.deltaY * .0015)); }, {passive: false});

  return {
    sync,
    // A successful refresh sends a pulse outward from the sun.
    pulse() { flare = 1; waveAge = 0; },
    focus(name) { if ((name || '') !== view.focus) view.pan.set(0, 0, 0); view.focus = name || ''; selected = name || ''; if (name) view.zoomTarget = Math.max(view.zoomTarget, 2); else view.zoomTarget = 1; },
    zoomBy(factor) { view.zoomTarget = clampZoom(view.zoomTarget * factor); },
    pick,
    viewState() { return {zoom: view.zoomTarget, pan: view.pan.toArray()}; },
    describe() { return model.map(h => h.name + ': ' + gaugeText(h.gauges)).join('\n'); }
  };
}
