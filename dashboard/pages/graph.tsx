import {useEffect, useMemo, useRef, useState} from 'react';
import {call, button, errorText, Panel, Data, exportJSON, useLoad, StatusBadge} from '../lib/page-helpers';
import {Source} from './source';

type Notify = (message: string, error?: boolean) => void;
type GraphNode = {id: string; kind: string; label: string; chat_type?: string; [key: string]: any};
type GraphEdge = {from: string; to: string; kind: string};
type GraphData = {nodes: GraphNode[]; edges: GraphEdge[]; [key: string]: any};
type Scope = {scope: string; events: number};
type GraphScene = {
  dispose(): void;
  update(options: {selectedId?: string; matchingIds: Set<string> | null; labels: boolean}): void;
  fit(): void;
  orbit(x: number, y: number): void;
  zoom(factor: number): void;
  focus(id?: string): void;
};

const graphKinds: Record<string, string> = {
  collection: 'Collection',
  user: 'User',
  project: 'Project',
  group: 'Group',
  message: 'Message',
};
const nodeKindLabel = (node: GraphNode) =>
  node.kind === 'group' && node.chat_type === 'private' ? 'Private chat' : graphKinds[node.kind] || node.kind;
const kindFilterLabel = (kind: string, nodes: GraphNode[]) => {
  if (kind !== 'group') return graphKinds[kind] || kind;
  const conversations = nodes.filter(node => node.kind === 'group'),
    hasPrivate = conversations.some(node => node.chat_type === 'private'),
    hasGroup = conversations.some(node => node.chat_type !== 'private');
  return hasPrivate && hasGroup ? 'Groups / private chats' : hasPrivate ? 'Private chats' : 'Groups';
};
const graphLegend = (nodes: GraphNode[]) =>
  Object.keys(graphKinds).flatMap(kind => {
    if (kind !== 'group')
      return nodes.some(node => node.kind === kind) ? [{key: kind, kind, label: graphKinds[kind]}] : [];
    const entries: {key: string; kind: string; label: string}[] = [];
    if (nodes.some(node => node.kind === 'group' && node.chat_type === 'private'))
      entries.push({key: 'private-chat', kind: 'group', label: 'Private chat'});
    if (nodes.some(node => node.kind === 'group' && node.chat_type !== 'private'))
      entries.push({key: 'group', kind: 'group', label: 'Group'});
    return entries;
  });
const contextGraph = (value: any): GraphData => {
  const nodes = ((value?.nodes || []) as GraphNode[]).filter(node => Object.hasOwn(graphKinds, node.kind)),
    ids = new Set(nodes.map(node => node.id));
  return {
    ...value,
    nodes,
    edges: ((value?.edges || []) as GraphEdge[]).filter(edge => ids.has(edge.from) && ids.has(edge.to)),
  };
};

// Served next to the dashboard bundle and loaded only when the graph opens; the
// variable keeps the bundler and type checker from resolving it as a local file.
const graphSceneModule = '/assets/graph-3d.js';
type CreateGraphScene = (
  host: HTMLDivElement | null,
  data: GraphData,
  handlers: {onSelect: (node: GraphNode) => void; onError: (message: string) => void},
) => GraphScene;

const cameraLabels: Record<string, string> = {
  '←': 'Orbit left',
  '→': 'Orbit right',
  '↑': 'Orbit up',
  '↓': 'Orbit down',
  '−': 'Zoom out',
  '+': 'Zoom in',
};

function GraphSpace({
  data,
  selectedId,
  matchingIds,
  choose,
}: {
  data: GraphData;
  selectedId?: string;
  matchingIds: Set<string> | null;
  choose: (node: GraphNode) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    scene = useRef<GraphScene | null>(null),
    onChoose = useRef(choose);
  const [problem, setProblem] = useState(''),
    [ready, setReady] = useState(false),
    [retry, setRetry] = useState(0),
    [labels, setLabels] = useState(true),
    [expanded, setExpanded] = useState(false),
    [expandError, setExpandError] = useState('');
  onChoose.current = choose;
  useEffect(() => {
    const change = () => setExpanded(document.fullscreenElement === host.current?.parentElement);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  const expand = async () => {
    setExpandError('');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await host.current!.parentElement!.requestFullscreen();
    } catch {
      setExpandError('Full screen is unavailable in this browser.');
    }
  };
  useEffect(() => {
    let alive = true;
    setReady(false);
    setProblem('');
    import(graphSceneModule)
      .then((module: {createGraphScene: CreateGraphScene}) => {
        if (!alive) return;
        scene.current = module.createGraphScene(host.current, data, {
          onSelect: (node: GraphNode) => onChoose.current(node),
          onError: (message: string) => {
            if (alive) {
              setProblem(message);
              setReady(false);
            }
          },
        });
        setReady(true);
      })
      .catch(() => {
        if (alive)
          setProblem(
            'The 3D view could not start. Check that graphics acceleration is available, then reload the scene. You can still inspect every node in the node browser.',
          );
      });
    return () => {
      alive = false;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [data, retry]);
  useEffect(() => {
    scene.current?.update({selectedId, matchingIds, labels});
  }, [selectedId, matchingIds, labels, ready]);
  const action = (label: string, fn: (scene: GraphScene) => void) => (
    <button
      type="button"
      disabled={!ready}
      onClick={() => fn(scene.current!)}
      aria-label={cameraLabels[label] || label}
      title={cameraLabels[label] || label}
    >
      {label}
    </button>
  );
  return (
    <div className="n-space-shell">
      <div className="n-space-top">
        <span className="n-space-title">
          Evidence space
          <small>{`3D · ${data.nodes.length} nodes · ${data.edges.length} links`}</small>
        </span>
        <div className="n-space-actions">
          <button type="button" aria-pressed={labels} onClick={() => setLabels(v => !v)} disabled={!ready}>
            Labels
          </button>
          {action('Reset view', v => v.fit())}
          {document.fullscreenEnabled && button(expanded ? 'Exit full screen' : 'Full screen', expand, !ready)}
        </div>
      </div>
      <div className="n-space" ref={host} aria-busy={!ready && !problem} />
      {!ready && (
        <div className="n-space-status" role={problem ? 'alert' : 'status'}>
          <p>{problem || 'Preparing your evidence space…'}</p>
          {problem && button('Reload scene', () => setRetry(v => v + 1))}
        </div>
      )}
      <div className="n-space-bottom">
        <div className="n-space-help" id="n-graph-help">
          Drag to orbit · scroll to zoom
          <small>Right-drag to pan · touch: one finger orbits, two pan / pinch</small>
        </div>
        <div className="n-space-actions" aria-label="Camera controls">
          {action('←', v => v.orbit(-0.25, 0))}
          {action('→', v => v.orbit(0.25, 0))}
          {action('↑', v => v.orbit(0, -0.25))}
          {action('↓', v => v.orbit(0, 0.25))}
          {action('−', v => v.zoom(1.25))}
          {action('+', v => v.zoom(0.8))}
        </div>
      </div>
      <div className="n-space-focus">
        {button('Focus selected node', () => scene.current?.focus(selectedId), !ready || !selectedId)}
        {expandError && <small role="status">{expandError}</small>}
      </div>
    </div>
  );
}

export function Graph({notify}: {notify: Notify}) {
  const selection = useRef(0),
    source = useRef<HTMLDivElement>(null),
    sourceRequest = useRef<AbortController | null>(null);
  const [scope, setScope] = useState('*'),
    [scopeAfter, setScopeAfter] = useState(''),
    [scopeList, setScopeList] = useState<Scope[]>([]),
    [scopes, scopeError] = useLoad('/scopes?after=' + encodeURIComponent(scopeAfter));
  const [after, setAfter] = useState(''),
    [history, setHistory] = useState<string[]>([]),
    [data, setData] = useState<GraphData | null>(null),
    [selected, setSelected] = useState<GraphNode | null>(null),
    [record, setRecord] = useState<any>(null);
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [retry, setRetry] = useState(0),
    [sourceBusy, setSourceBusy] = useState(false),
    [sourceError, setSourceError] = useState('');
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('');
  useEffect(() => {
    if (scopes?.scopes) {
      setScopeList(old => [
        ...new Map([...old, ...scopes.scopes].map((s: Scope): [string, Scope] => [s.scope, s])).values(),
      ]);
      if (!scope && scopes.scopes.length) setScope(scopes.scopes[0].scope);
    }
  }, [scopes]);
  useEffect(() => {
    if (!scope) return;
    let alive = true;
    const controller = new AbortController();
    selection.current++;
    sourceRequest.current?.abort();
    setBusy(true);
    setProblem('');
    setData(null);
    setRecord(null);
    setSelected(null);
    setSourceError('');
    setSourceBusy(false);
    setQuery('');
    setKind('');
    call('/graph?scope=' + encodeURIComponent(scope) + '&after=' + encodeURIComponent(after), undefined, {
      signal: controller.signal,
    })
      .then(value => {
        if (alive) setData(contextGraph(value));
      })
      .catch(e => {
        if (alive) setProblem(errorText(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      controller.abort();
      sourceRequest.current?.abort();
      selection.current++;
    };
  }, [scope, after, retry]);
  useEffect(() => {
    let alive = true,
      controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      setBusy(true);
      call('/graph?scope=' + encodeURIComponent(scope) + '&after=' + encodeURIComponent(after), undefined, {
        signal: controller.signal,
      })
        .then(value => {
          if (alive) {
            setData(contextGraph(value));
            setProblem('');
          }
        })
        .catch(e => {
          if (alive && e.name !== 'AbortError') setProblem(errorText(e));
        })
        .finally(() => {
          if (alive) setBusy(false);
        });
    };
    window.addEventListener('nocheh:refresh', refresh);
    return () => {
      alive = false;
      controller?.abort();
      window.removeEventListener('nocheh:refresh', refresh);
    };
  }, [scope, after]);
  const choose = async (node: GraphNode | null | undefined) => {
    if (!node) return;
    sourceRequest.current?.abort();
    const controller = new AbortController();
    sourceRequest.current = controller;
    const request = ++selection.current;
    setSelected(node);
    setRecord(null);
    setSourceError('');
    setSourceBusy(!!node.event_id);
    if (node.event_id)
      try {
        const value = await call('/events/' + encodeURIComponent(node.event_id), undefined, {
          signal: controller.signal,
        });
        if (selection.current === request) setRecord(value);
      } catch (e) {
        if (selection.current === request) setSourceError(errorText(e));
      } finally {
        if (selection.current === request) setSourceBusy(false);
      }
  };
  const byId = useMemo(() => new Map((data?.nodes || []).map(node => [node.id, node])), [data]);
  const filtered = useMemo(
    () =>
      (data?.nodes || []).filter(
        node =>
          (!kind || node.kind === kind) &&
          (!query.trim() ||
            (node.label + ' ' + node.kind + ' ' + nodeKindLabel(node) + ' ' + node.id)
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase())),
      ),
    [data, kind, query],
  );
  const matchingIds = useMemo(
    () => (kind || query.trim() ? new Set(filtered.map(node => node.id)) : null),
    [filtered, kind, query],
  );
  const connections = (data?.edges || []).filter(edge => edge.from === selected?.id || edge.to === selected?.id);
  return (
    <div className="n-graph-page">
      <div className="n-graph-intro">
        <div>
          <h2>Explore your context</h2>
          <p className="n-muted">
            Explore users, projects, groups, private chats, and messages in three dimensions. Actions and runtime events
            stay out of the graph.
          </p>
        </div>
        <label className="n-graph-scope">
          Archive scope
          <select
            value={scope}
            onChange={e => {
              setScope(e.target.value);
              setAfter('');
              setHistory([]);
            }}
          >
            <option value="*">All private knowledge</option>
            {scopeList.map(s => (
              <option key={s.scope} value={s.scope}>
                {s.scope + ' · ' + s.events + ' events'}
              </option>
            ))}
          </select>
        </label>
        {scopes?.next && button('Load more scopes', () => setScopeAfter(scopes.next))}
      </div>
      {scopeError && <p role="alert">{scopeError}</p>}
      {!scopes && !scopeError && <p role="status">Loading archive scopes…</p>}
      {scopes && !scopeList.length && (
        <Panel title="Your evidence space starts here">
          <p>Import a chat to explore its messages and connections.</p>
          <a href="#imports">Open Imports &amp; jobs</a>
        </Panel>
      )}
      {busy && (
        <div className="n-graph-loading" role="status">
          Loading source relationships…
        </div>
      )}
      {problem && (
        <Panel title="Graph unavailable">
          <p role="alert">{problem}</p>
          {button('Try again', () => setRetry(v => v + 1))}
        </Panel>
      )}
      {data && (
        <div>
          <div className="n-graph-workspace">
            <GraphSpace data={data} selectedId={selected?.id} matchingIds={matchingIds} choose={choose} />
            <aside className="n-graph-inspector" aria-label="Graph inspector">
              <div className="n-node-browser">
                <h3>Node browser</h3>
                <label htmlFor="n-node-search">Find on this page</label>
                <input
                  id="n-node-search"
                  type="search"
                  placeholder="Search nodes…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                <label className="n-sr-only" htmlFor="n-node-kind">
                  Node type
                </label>
                <select id="n-node-kind" value={kind} onChange={e => setKind(e.target.value)}>
                  <option value="">All types</option>
                  {Object.keys(graphKinds)
                    .filter(key => data.nodes.some(n => n.kind === key))
                    .map(key => (
                      <option key={key} value={key}>
                        {kindFilterLabel(key, data.nodes)}
                      </option>
                    ))}
                </select>
                <small role="status">{filtered.length + ' of ' + data.nodes.length + ' nodes'}</small>
                <div className="n-node-list">
                  {filtered.map(node => (
                    <button
                      type="button"
                      key={node.id}
                      className="n-node-option"
                      aria-pressed={selected?.id === node.id}
                      onClick={() => choose(node)}
                      title={nodeKindLabel(node).toLocaleLowerCase() + ': ' + node.label}
                    >
                      <span className={'n-kind-dot n-kind-' + node.kind} aria-hidden={true} />
                      <span>
                        <small>{nodeKindLabel(node)}</small>
                        <span dir="auto">{node.label}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {!filtered.length && (
                  <p className="n-muted">No nodes match. Clear your search or choose another type.</p>
                )}
              </div>
              <div className="n-node-detail">
                {selected ? (
                  <div>
                    <div className="n-selection-heading">
                      <h3>{nodeKindLabel(selected)}</h3>
                      {button('Clear', () => {
                        sourceRequest.current?.abort();
                        selection.current++;
                        setSelected(null);
                        setRecord(null);
                        setSourceError('');
                        setSourceBusy(false);
                      })}
                    </div>
                    <p className="n-node-title" dir="auto">
                      {selected.label}
                    </p>
                    {selected.state && <StatusBadge state={selected.state} />}
                    {selected.text && <Data value={selected.text} />}
                    {selected.provenance && (
                      <details>
                        <summary>Generation provenance</summary>
                        <Data value={selected.provenance} />
                      </details>
                    )}
                    {selected.unresolved_citations > 0 && (
                      <p className="n-muted">
                        {selected.unresolved_citations + ' citations are outside this page or scope.'}
                      </p>
                    )}
                    {sourceBusy && <p role="status">Loading original source…</p>}
                    {sourceError && (
                      <div>
                        <p role="alert">{sourceError}</p>
                        {button('Retry source', () => choose(selected))}
                      </div>
                    )}
                    {record &&
                      button(
                        'View original source',
                        () => source.current?.scrollIntoView({block: 'start'}),
                        false,
                        'n-primary',
                      )}
                    {!selected.event_id && (
                      <p className="n-muted">Follow a connection to a message to inspect its original source.</p>
                    )}
                    <details open={true}>
                      <summary>{connections.length + ' direct connections'}</summary>
                      {connections.map((edge, i) => {
                        const target = byId.get(edge.from === selected.id ? edge.to : edge.from);
                        if (!target) return null;
                        return (
                          <button type="button" key={i} className="n-connection" onClick={() => choose(target)}>
                            <small>
                              {(edge.from === selected.id ? 'Outgoing · ' : 'Incoming · ') +
                                edge.kind.replaceAll('_', ' ')}
                            </small>
                            <span dir="auto">{target.label}</span>
                          </button>
                        );
                      })}
                    </details>
                  </div>
                ) : (
                  <div>
                    <h3>Inspect a connection</h3>
                    <p className="n-muted">
                      Select a node in the space or the list. Its direct connections will light up here.
                    </p>
                    <p className="n-muted">
                      Positions help you navigate. Only the links represent recorded relationships.
                    </p>
                  </div>
                )}
              </div>
            </aside>
          </div>
          <div className="n-graph-legend" aria-label="Node legend">
            {graphLegend(data.nodes).map(entry => (
              <span key={entry.key}>
                <i className={'n-kind-dot n-kind-' + entry.kind} aria-hidden={true} />
                {entry.label}
              </span>
            ))}
          </div>
          <div className="n-graph-pagination">
            <p className="n-muted">
              {'Page ' +
                (history.length + 1) +
                ' · ' +
                data.nodes.filter(n => n.kind === 'message').length +
                ' messages · ' +
                data.unresolved_replies +
                ' reply references outside this page'}
            </p>
            <div className="n-space-actions">
              {button(
                'Previous messages',
                () => {
                  setAfter(history.at(-1)!);
                  setHistory(history.slice(0, -1));
                },
                !history.length,
              )}
              {button(
                'Next messages',
                () => {
                  setHistory([...history, after]);
                  setAfter(data.next);
                },
                !data.next,
              )}
              {button('Export graph JSON', () => exportJSON(data, 'nocheh-graph.json'))}
            </div>
          </div>
          {data.bounds.truncated && (
            <p role="status">The context-entity limit was reached. Choose a narrower archive scope to inspect more.</p>
          )}
          {!data.nodes.some(n => n.kind === 'message') && (
            <p className="n-muted">No messages on this page. Choose another scope or return to the previous page.</p>
          )}
          <p className="n-muted">
            Recorded context relationships only. Actions and events are excluded, and this view makes no model calls.
          </p>
          {record && (
            <div ref={source} id="n-graph-source">
              <Source record={record} notify={notify} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
