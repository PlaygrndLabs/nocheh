// Coordinates are a navigation aid, never a semantic claim or a source fact.
export const NODE_STYLES = {
  group: {color: '#80d6c0', label: 'Group', size: 7},
  project: {color: '#c1aff5', label: 'Project', size: 5.5},
  user: {color: '#edac90', label: 'User', size: 5.5},
  message: {color: '#83c9f4', label: 'Message', size: 3.7},
};
export const nodeStyle = kind => NODE_STYLES[kind] || NODE_STYLES.message;
export const isReference = edge => ['derived_from', 'explicit_citation'].includes(edge.kind);

export function neighborhood(data, id) {
  const ids = new Set(id ? [id] : []);
  for (const edge of data.edges) {
    if (edge.from === id) ids.add(edge.to);
    if (edge.to === id) ids.add(edge.from);
  }
  return ids;
}

export function layoutGraph(data) {
  const ordered = [...data.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const nodes = ordered.map((node, i) => {
    const y = 1 - 2 * (i + .5) / Math.max(1, ordered.length);
    const ring = Math.sqrt(1 - y * y), angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = 36 + Math.sqrt(ordered.length) * 8;
    return {...node, x: radius * ring * Math.cos(angle), y: radius * y,
      z: radius * ring * Math.sin(angle), vx: 0, vy: 0, vz: 0};
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const rootId = byId.has('group:*') ? 'group:*' : nodes.find(node => node.kind === 'group')?.id;
  const edges = data.edges.filter(edge => byId.has(edge.from) && byId.has(edge.to));
  // A bounded deterministic spring layout. It settles before display; no idle motion.
  for (let step = 0; step < 100; step++) {
    const cooling = 1 - step / 120;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        const distance = Math.max(1, Math.hypot(dx, dy, dz));
        const force = Math.min(3, 650 / (distance * distance)) * cooling / distance;
        a.vx += dx * force; a.vy += dy * force; a.vz += dz * force;
        b.vx -= dx * force; b.vy -= dy * force; b.vz -= dz * force;
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.from), b = byId.get(edge.to);
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const length = ['attachment', 'derived_from'].includes(edge.kind) ? 24 : edge.kind === 'contains' ? 76 : 48;
      const force = (distance - length) * .018 * cooling / distance;
      a.vx += dx * force; a.vy += dy * force; a.vz += dz * force;
      b.vx -= dx * force; b.vy -= dy * force; b.vz -= dz * force;
    }
    for (const node of nodes) {
      for (const axis of ['x', 'y', 'z']) {
        const velocity = 'v' + axis;
        node[velocity] = (node[velocity] - node[axis] * .003 * cooling) * .7;
        node[axis] += node[velocity];
      }
      if (node.id === rootId) node.x = node.y = node.z = 0;
    }
  }
  return {nodes, edges};
}
