import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { layoutGraph, neighborhood, nodeStyle, isReference } from './graph-layout.mjs';

export function createGraphScene(host, data, {onSelect, onError}) {
  const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D evidence graph. Arrow keys orbit; Shift and arrows pan; plus and minus zoom; Home resets. Select nodes in the node browser.');
  canvas.setAttribute('aria-describedby', 'n-graph-help');
  host.appendChild(canvas);
  const labels = document.createElement('div');
  labels.className = 'n-space-labels'; labels.setAttribute('aria-hidden', 'true'); host.appendChild(labels);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, 1, .1, 10000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.minDistance = 18; controls.maxDistance = 2500;
  controls.zoomSpeed = .75; controls.rotateSpeed = .65;
  const ambient = new THREE.HemisphereLight(0xe4f2ff, 0x223e55, 2.8);
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(-100, 200, 150);
  scene.add(ambient, light);
  const graph = layoutGraph(data);
  const geometries = {
    collection: new THREE.DodecahedronGeometry(1),
    message: new THREE.SphereGeometry(1, 16, 12),
    author: new THREE.OctahedronGeometry(1),
    scope: new THREE.IcosahedronGeometry(1, 1),
    profile: new THREE.IcosahedronGeometry(1),
    attachment: new THREE.BoxGeometry(1.4, 1.4, 1.4),
    memory: new THREE.OctahedronGeometry(1),
    derived: new THREE.TetrahedronGeometry(1.35),
  };
  const meshes = new Map(), nodeLabels = new Map(), lines = [];
  for (const node of graph.nodes) {
    const style = nodeStyle(node.kind);
    const material = new THREE.MeshStandardMaterial({color: style.color, emissive: style.color,
      emissiveIntensity: .14, roughness: .4, metalness: .08, transparent: true});
    const mesh = new THREE.Mesh(geometries[node.kind] || geometries.message, material);
    mesh.position.set(node.x, node.y, node.z); mesh.scale.setScalar(style.size);
    mesh.userData.node = node; meshes.set(node.id, mesh); scene.add(mesh);
    const label = document.createElement('span');
    label.className = 'n-space-label'; label.textContent = node.label;
    label.style.setProperty('--node-color', style.color);
    labels.appendChild(label); nodeLabels.set(node.id, label);
  }
  for (const edge of graph.edges) {
    const geometry = new THREE.BufferGeometry().setFromPoints([meshes.get(edge.from).position, meshes.get(edge.to).position]);
    const options = {color: isReference(edge) ? 0xbba6d8 : 0x6a99ba, transparent: true, opacity: .38};
    const material = isReference(edge) ? new THREE.LineDashedMaterial({...options, dashSize: 2.5, gapSize: 2}) : new THREE.LineBasicMaterial(options);
    const line = new THREE.Line(geometry, material); line.computeLineDistances(); scene.add(line); lines.push({edge, line});
  }
  const extent = Math.max(40, ...graph.nodes.map(node => Math.hypot(node.x, node.y, node.z) + 12));
  const grid = new THREE.GridHelper(extent * 3.5, 24, 0x314b63, 0x23394f);
  grid.position.y = -extent * .85; grid.material.transparent = true; grid.material.opacity = .45;
  scene.add(grid);
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.5, 48), new THREE.MeshBasicMaterial({color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: .9, depthTest: false}));
  halo.visible = false; scene.add(halo);
  const picker = new THREE.Raycaster(), pointer = new THREE.Vector2(), projected = new THREE.Vector3();
  let selected = null, hovered = null, matches = null, showLabels = true, connected = new Set();
  let frame = 0, disposed = false, lost = false;
  const render = () => {
    frame = 0;
    if (disposed || lost) return;
    const width = host.clientWidth, height = host.clientHeight;
    camera.updateMatrixWorld(); halo.quaternion.copy(camera.quaternion);
    const occupied = [];
    // Selected/hovered labels take precedence. Other labels avoid overlaps.
    const ordered = [...meshes.entries()].sort(([a], [b]) => Number(b === selected || b === hovered) - Number(a === selected || a === hovered));
    for (const [id, mesh] of ordered) {
      const node = mesh.userData.node, label = nodeLabels.get(id);
      const active = id === selected || id === hovered;
      const context = selected ? connected.has(id) : matches ? matches.has(id) : node.kind !== 'message' || graph.nodes.length < 16;
      projected.copy(mesh.position).project(camera);
      const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2 + 14;
      const box = {x: Math.min(Math.max(x, 95), Math.max(95, width - 95)), y};
      const overlaps = occupied.some(other => Math.abs(box.x - other.x) < 185 && Math.abs(box.y - other.y) < 30);
      const visible = (active || (showLabels && context && !overlaps)) && projected.z > -1 && projected.z < 1 && x > 0 && x < width && y > 0 && y < height - 24;
      label.hidden = !visible;
      if (visible) {
        occupied.push(box); label.style.transform = `translate(${box.x}px, ${y}px) translateX(-50%)`;
        label.classList.toggle('is-active', active);
      }
    }
    renderer.render(scene, camera);
  };
  const invalidate = () => { if (!frame && !disposed && !lost) frame = requestAnimationFrame(render); };
  function fit() {
    controls.target.set(0, 0, 0);
    const halfAngle = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
    const distance = extent / Math.sin(halfAngle) * 1.12;
    controls.maxDistance = Math.max(2500, distance * 3);
    camera.position.set(.55, .28, 1).normalize().multiplyScalar(distance);
    controls.update(); invalidate();
  }
  function resize() {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); invalidate();
  }
  function highlight() {
    const active = hovered || selected;
    const neighbors = active ? neighborhood(data, active) : null;
    for (const [id, mesh] of meshes) {
      const visible = neighbors ? neighbors.has(id) : !matches || matches.has(id);
      mesh.material.opacity = visible ? 1 : .17;
      mesh.material.emissiveIntensity = id === active ? .65 : .14;
    }
    for (const {edge, line} of lines) {
      const relevant = active ? edge.from === active || edge.to === active : !matches || matches.has(edge.from) || matches.has(edge.to);
      line.material.opacity = relevant ? active ? .9 : .38 : .055;
    }
    halo.visible = !!selected;
    if (selected && meshes.has(selected)) { const mesh = meshes.get(selected); halo.position.copy(mesh.position); halo.scale.copy(mesh.scale); }
    invalidate();
  }
  function hit(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    picker.setFromCamera(pointer, camera);
    return picker.intersectObjects([...meshes.values()], false)[0]?.object.userData.node;
  }
  let pressed = null;
  function down(event) {
    if (!event.isPrimary) { if (pressed) pressed.moved = true; return; }
    pressed = {x: event.clientX, y: event.clientY, moved: false, button: event.button};
  }
  function move(event) {
    if (pressed) {
      if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5) pressed.moved = true;
      return;
    }
    const id = hit(event)?.id || null;
    if (id !== hovered) { hovered = id; canvas.style.cursor = id ? 'pointer' : 'grab'; highlight(); }
  }
  function up(event) {
    if (pressed && !pressed.moved && pressed.button === 0 && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) <= 5) {
      const node = hit(event); if (node) onSelect(node);
    }
    pressed = null;
  }
  function leave() { pressed = null; hovered = null; canvas.style.cursor = 'grab'; highlight(); }
  function orbit(horizontal, vertical) {
    const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    spherical.theta += horizontal; spherical.phi = THREE.MathUtils.clamp(spherical.phi + vertical, .05, Math.PI - .05);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); controls.update(); invalidate();
  }
  function zoom(factor) {
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance));
    camera.position.copy(controls.target).add(offset); controls.update(); invalidate();
  }
  function key(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const arrows = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
    if (arrows[event.key]) {
      const [x, y] = arrows[event.key];
      if (event.shiftKey) {
        const step = camera.position.distanceTo(controls.target) * .035;
        const delta = new THREE.Vector3(x * step, -y * step, 0).applyQuaternion(camera.quaternion);
        controls.target.add(delta); camera.position.add(delta); controls.update(); invalidate();
      } else orbit(x * .15, y * .15);
    } else if (event.key === '+' || event.key === '=') zoom(.8);
    else if (event.key === '-') zoom(1.25);
    else if (event.key === 'Home') fit();
    else return;
    event.preventDefault();
  }
  function contextLost(event) { event.preventDefault(); lost = true; onError('The 3D view lost its graphics context. Reload the scene to continue, or use the node browser.'); }
  controls.addEventListener('change', invalidate);
  const listeners = {pointerdown: down, pointermove: move, pointerup: up, pointerleave: leave, pointercancel: leave, keydown: key, webglcontextlost: contextLost};
  for (const [name, callback] of Object.entries(listeners)) canvas.addEventListener(name, callback);
  const observer = new ResizeObserver(resize); observer.observe(host);
  resize(); fit();
  return {
    fit, zoom, orbit,
    focus(id) {
      const mesh = meshes.get(id); if (!mesh) return;
      const offset = camera.position.clone().sub(controls.target).setLength(105);
      controls.target.copy(mesh.position); camera.position.copy(mesh.position).add(offset); controls.update(); invalidate();
    },
    update({selectedId, matchingIds, labels: enabled}) {
      selected = meshes.has(selectedId) ? selectedId : null;
      connected = neighborhood(data, selected); matches = matchingIds; showLabels = enabled; highlight();
    },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      for (const [name, callback] of Object.entries(listeners)) canvas.removeEventListener(name, callback);
      for (const geometry of Object.values(geometries)) geometry.dispose();
      for (const mesh of meshes.values()) mesh.material.dispose();
      for (const {line} of lines) { line.geometry.dispose(); line.material.dispose(); }
      grid.geometry.dispose(); grid.material.dispose(); halo.geometry.dispose(); halo.material.dispose();
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); labels.remove();
    },
  };
}
