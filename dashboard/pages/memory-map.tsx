import {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Connection,
  type Edge as FlowEdge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  ArrowRight,
  BrainCircuit,
  FolderKanban,
  Hash,
  List,
  Map as MapIcon,
  MessageCircle,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Sheet,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui/primitives';
import {CursorButtons, EvidenceLinks, Provenance, ResourceState, useOwnerCommand} from '../lib/owner-controls';
import {connectionDescription, shareableFact} from '../lib/memory-access-presentation';
import {layoutMemoryMap} from '../lib/memory-map-layout';
import {useResource} from '../lib/resource';
import {countLabel, destinationName, RequestRow, type MapNode, type NodeKind} from '../components/memory-access';

type MapEdge = {
  id: string;
  kind: 'relationship' | 'project_assignment' | 'access' | 'suggestion';
  source: string;
  target: string;
  state?: string;
  label?: string;
  authoritative: boolean;
  detail?: Record<string, any>;
};
type MapData = {nodes: MapNode[]; edges: MapEdge[]; next: string | null; counts: {nodes: number; edges: number}};
type Project = {id: string; name: string; description: string; state: 'active' | 'archived'; revision: number};
type Assignment = {
  space_id: string;
  project_id: string | null;
  mode: 'assigned' | 'none' | 'inherit';
  revision: number;
};
type Selection =
  | {type: 'node'; value: MapNode}
  | {type: 'edge'; value: MapEdge}
  | {type: 'connect'; fact?: MapNode; project?: MapNode; destination: MapNode};
type MemoryMapView = 'map' | 'list';

const kindLabels: Record<NodeKind, string> = {
  person: 'Person',
  project: 'Project',
  conversation: 'Conversation',
  topic: 'Topic',
  fact: 'Memory fact',
};
const kindDescriptions: Record<NodeKind, string> = {
  person: 'Someone Nocheh remembers',
  project: 'Organizes work; grants no access',
  conversation: 'A chat or group with its own access',
  topic: 'A separate access scope inside a group',
  fact: 'A specific remembered statement',
};
const edgeLabels: Record<MapEdge['kind'], string> = {
  relationship: 'Related context',
  project_assignment: 'In project',
  access: 'Memory access',
  suggestion: 'Suggested share',
};
const edgeDescriptions: Record<MapEdge['kind'], string> = {
  relationship: 'Description only; no access',
  project_assignment: 'Organization only; no access',
  access: 'Only active grants allow recall',
  suggestion: 'Waiting for your review',
};
const colors: Record<NodeKind, string> = {
  person: '#387bbd',
  project: '#7357a8',
  conversation: '#25816f',
  topic: '#d07135',
  fact: '#7a858c',
};
const kindIcons: Record<NodeKind, typeof UserRound> = {
  person: UserRound,
  project: FolderKanban,
  conversation: MessageCircle,
  topic: Hash,
  fact: BrainCircuit,
};

function MapLegend() {
  return (
    <section className="memory-map-guide" aria-labelledby="memory-map-guide-title" aria-label="How to use this map">
      <div className="memory-map-guide-heading">
        <SlidersHorizontal size={17} aria-hidden="true" />
        <div>
          <h3 id="memory-map-guide-title">Read the map</h3>
          <p>Every card and connection is named. Select one to inspect or edit it.</p>
        </div>
      </div>
      <div className="memory-map-legend-group">
        <h4>Cards</h4>
        <dl>
          {(Object.keys(kindLabels) as NodeKind[]).map(kind => {
            const Icon = kindIcons[kind];
            return (
              <div key={kind}>
                <dt>
                  <span className={'memory-map-node-key ' + kind}>
                    <Icon size={11} aria-hidden="true" />
                  </span>
                  {kindLabels[kind]}
                </dt>
                <dd>{kindDescriptions[kind]}</dd>
              </div>
            );
          })}
        </dl>
      </div>
      <div className="memory-map-legend-group">
        <h4>Connections</h4>
        <dl>
          {(Object.keys(edgeLabels) as MapEdge['kind'][]).map(kind => (
            <div key={kind}>
              <dt>
                <span className={'memory-map-edge-key ' + kind} />
                {edgeLabels[kind]}
              </dt>
              <dd>{edgeDescriptions[kind]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

type MemoryFlowNode = FlowNode<{item: MapNode}, 'memoryNode'>;
type MemoryFlowEdge = FlowEdge<{item: MapEdge}, 'memoryEdge'>;
const grouped = (nodes: MapNode[]) => {
  const value: Record<NodeKind, MapNode[]> = {person: [], project: [], conversation: [], topic: [], fact: []};
  for (const node of nodes) value[node.kind].push(node);
  return value;
};
function flowNodes(items: MapNode[]): MemoryFlowNode[] {
  const groups = grouped(items),
    xs: Record<NodeKind, number> = {person: 0, project: 280, conversation: 590, topic: 880, fact: 1170},
    result: MemoryFlowNode[] = [];
  for (const kind of Object.keys(groups) as NodeKind[])
    groups[kind]
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((item, index) =>
        result.push({
          id: item.id,
          type: 'memoryNode',
          position: {x: xs[kind], y: index * 126},
          data: {item},
          ariaLabel: `${kindLabels[item.kind]}: ${item.label}`,
          connectable: item.kind !== 'person',
        }),
      );
  return result;
}
function MemoryNode({data, selected}: NodeProps<MemoryFlowNode>) {
  const {item} = data,
    Icon = kindIcons[item.kind],
    connectable = item.kind !== 'person';
  return (
    <div
      className={`memory-flow-node ${item.kind}${selected ? ' selected' : ''}`}
      style={{'--node-color': colors[item.kind]} as CSSProperties}
    >
      {connectable && <Handle type="target" position={Position.Left} className="memory-flow-handle" />}
      <div className="memory-flow-node-top">
        <span>
          <Icon size={12} aria-hidden="true" />
          {kindLabels[item.kind]}
        </span>
        {item.state && <em>{item.state}</em>}
      </div>
      <strong>{item.label}</strong>
      {connectable && <Handle type="source" position={Position.Right} className="memory-flow-handle" />}
    </div>
  );
}
function MemoryEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
  selected,
}: EdgeProps<MemoryFlowEdge>) {
  const item = data!.item,
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 18,
    });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={24}
        className={`memory-flow-edge ${item.kind}${selected ? ' selected' : ''}`}
      />
      <EdgeLabelRenderer>
        <div
          className={`memory-flow-edge-label ${item.kind}`}
          style={{transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`}}
        >
          {edgeLabels[item.kind]}
          {item.state ? <span>{item.state}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = {memoryNode: MemoryNode},
  edgeTypes = {memoryEdge: MemoryEdge};

function useCompactGraph() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)'),
      sync = () => setCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return compact;
}

function GraphView({
  data,
  showFacts,
  onSelect,
  onConnectEdit,
}: {
  data: MapData;
  showFacts: boolean;
  onSelect: (value: Selection) => void;
  onConnectEdit: (value: Selection) => void;
}) {
  const compact = useCompactGraph();
  const visible = useMemo(() => data.nodes.filter(node => showFacts || node.kind !== 'fact'), [data.nodes, showFacts]),
    ids = useMemo(() => new Set(visible.map(node => node.id)), [visible]);
  const makeNodes = useCallback(() => flowNodes(visible), [visible]),
    makeEdges = useCallback(
      (): MemoryFlowEdge[] =>
        data.edges
          .filter(edge => ids.has(edge.source) && ids.has(edge.target))
          .map(item => ({
            id: item.id,
            type: 'memoryEdge',
            source: item.source,
            target: item.target,
            data: {item},
            ariaLabel: `${edgeLabels[item.kind]}: ${connectionDescription(item)}`,
            selectable: true,
            focusable: true,
          })),
      [data.edges, ids],
    );
  const [nodes, setNodes] = useState<MemoryFlowNode[]>(makeNodes),
    [edges, setEdges] = useState<MemoryFlowEdge[]>(makeEdges),
    [instance, setInstance] = useState<ReactFlowInstance<MemoryFlowNode, MemoryFlowEdge> | null>(null),
    [layoutState, setLayoutState] = useState<'running' | 'ready' | 'fallback'>('running'),
    layoutRevision = useRef(0);
  const arrange = useCallback(async () => {
    const revision = ++layoutRevision.current,
      nextNodes = makeNodes(),
      nextEdges = makeEdges();
    setEdges(nextEdges);
    setLayoutState('running');
    try {
      const layouted = await layoutMemoryMap(nextNodes, nextEdges, compact ? 'DOWN' : 'RIGHT');
      if (revision !== layoutRevision.current) return;
      setNodes(layouted);
      setLayoutState('ready');
      requestAnimationFrame(
        () =>
          void instance?.fitView({
            padding: 0.24,
            maxZoom: 0.9,
            duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
          }),
      );
    } catch {
      if (revision !== layoutRevision.current) return;
      setNodes(nextNodes);
      setLayoutState('fallback');
      requestAnimationFrame(
        () =>
          void instance?.fitView({
            padding: 0.24,
            maxZoom: 0.9,
            duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
          }),
      );
    }
  }, [compact, instance, makeEdges, makeNodes]);
  useEffect(() => {
    void arrange();
    return () => {
      layoutRevision.current += 1;
    };
  }, [arrange]);
  const valid = useCallback(
    (connection: Connection | MemoryFlowEdge) => {
      const a = visible.find(node => node.id === connection.source),
        b = visible.find(node => node.id === connection.target),
        pair = [a?.kind, b?.kind];
      return (
        (pair.includes('fact') && (pair.includes('conversation') || pair.includes('topic'))) ||
        (pair.includes('project') && (pair.includes('conversation') || pair.includes('topic')))
      );
    },
    [visible],
  );
  const connect = useCallback(
    (connection: Connection) => {
      const a = visible.find(node => node.id === connection.source),
        b = visible.find(node => node.id === connection.target);
      if (!a || !b) return;
      const destination = [a, b].find(node => node.kind === 'conversation' || node.kind === 'topic');
      if (!destination) return;
      const fact = [a, b].find(node => node.kind === 'fact'),
        project = [a, b].find(node => node.kind === 'project');
      onConnectEdit({type: 'connect', destination, ...(fact ? {fact} : {}), ...(project ? {project} : {})});
    },
    [visible, onConnectEdit],
  );
  return (
    <div className="memory-flow-canvas" role="region" aria-label="Memory relationship and access graph">
      <ReactFlow<MemoryFlowNode, MemoryFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={setInstance}
        onNodesChange={(changes: NodeChange<MemoryFlowNode>[]) =>
          setNodes(current => applyNodeChanges(changes, current))
        }
        onNodeClick={(_, node) => onSelect({type: 'node', value: node.data.item})}
        onEdgeClick={(_, edge) => onSelect({type: 'edge', value: edge.data!.item})}
        onConnect={connect}
        isValidConnection={valid}
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={null}
        edgesReconnectable={false}
        fitView
        fitViewOptions={{padding: 0.24, maxZoom: 0.9}}
        minZoom={0.22}
        maxZoom={2}
        onlyRenderVisibleElements
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        <MiniMap nodeColor={node => colors[(node as MemoryFlowNode).data.item.kind]} pannable zoomable />
        <Controls showInteractive={false} />
        <Panel position="top-right">
          <div className="memory-flow-layout">
            <span aria-live="polite">
              {layoutState === 'running'
                ? 'Arranging…'
                : layoutState === 'ready'
                  ? 'Drag to arrange'
                  : 'Automatic layout unavailable'}
            </span>
            <button
              className="memory-flow-reset nodrag"
              type="button"
              aria-label="Reset layout"
              disabled={layoutState === 'running'}
              onClick={() => void arrange()}
            >
              <span className="memory-flow-reset-wide">Reset layout</span>
              <span className="memory-flow-reset-compact" aria-hidden="true">
                Reset
              </span>
            </button>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

const endpointName = (id: string, nodes: MapNode[]) =>
  nodes.find(node => node.id === id)?.label ?? 'Record outside this page';

function ConnectionList({
  edges,
  nodes,
  onSelect,
}: {
  edges: MapEdge[];
  nodes: MapNode[];
  onSelect: (value: Selection) => void;
}) {
  return (
    <ul className="memory-connections">
      {edges.map(edge => (
        <li key={edge.id}>
          <button type="button" onClick={() => onSelect({type: 'edge', value: edge})}>
            <span className="memory-connection-heading">
              <span className={'memory-map-edge-key ' + edge.kind} />
              <strong>{edgeLabels[edge.kind]}</strong>
              {edge.state && <Badge>{edge.state.replaceAll('_', ' ')}</Badge>}
            </span>
            <span className="memory-connection-path">
              <span>{endpointName(edge.source, nodes)}</span>
              <ArrowRight size={15} aria-hidden="true" />
              <span>{endpointName(edge.target, nodes)}</span>
            </span>
            <small>{connectionDescription(edge)}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}
function MemoryList({
  nodes,
  edges,
  onSelect,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  onSelect: (value: Selection) => void;
}) {
  const groups = grouped(nodes),
    kinds = (Object.keys(groups) as NodeKind[]).filter(kind => groups[kind].length);
  if (!nodes.length)
    return <EmptyState title="No memory items found">Clear a filter or try a broader search.</EmptyState>;
  return (
    <div className="memory-map-list" role="region" aria-label="Complete list fallback">
      <div className="memory-map-list-groups">
        {kinds.map(kind => (
          <section key={kind} aria-labelledby={`memory-list-${kind}`}>
            <div className="memory-map-list-group-heading">
              <h4 id={`memory-list-${kind}`}>{kindLabels[kind]}</h4>
              <span>{groups[kind].length}</span>
            </div>
            <ul>
              {groups[kind].map(node => {
                const Icon = kindIcons[node.kind];
                return (
                  <li key={node.id}>
                    <button type="button" onClick={() => onSelect({type: 'node', value: node})}>
                      <span className={`memory-map-list-icon ${node.kind}`}>
                        <Icon size={18} aria-hidden="true" />
                      </span>
                      <span className="memory-map-list-copy">
                        <strong>{node.label}</strong>
                        <small>{node.state?.replaceAll('_', ' ') || kindDescriptions[node.kind]}</small>
                      </span>
                      <span className="memory-map-list-action">
                        Open <ArrowRight size={14} aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {edges.length > 0 && (
        <details className="memory-connection-disclosure">
          <summary>Connections on this page ({edges.length})</summary>
          <ConnectionList edges={edges} nodes={nodes} onSelect={onSelect} />
        </details>
      )}
    </div>
  );
}

function DestinationPicker({
  value,
  onChange,
  nodes,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  nodes: MapNode[];
  disabled?: boolean;
}) {
  const [manual, setManual] = useState(false),
    [pages, setPages] = useState(['']),
    spaces = useResource<{spaces: {id: string}[]; next: string | null}>(
      '/memory/spaces?after=' + encodeURIComponent(pages.at(-1)!),
    );
  const options = new Set(
    [
      ...nodes
        .filter(node => ['conversation', 'topic'].includes(node.kind))
        .map(node => String(node.detail?.space_id ?? '')),
      ...(spaces.data?.spaces.map(space => space.id) ?? []),
      value,
    ].filter(id => /^-\d+(?:\/topic\/\d+)?$/.test(id)),
  );
  return (
    <div className="memory-destination-picker">
      <label>
        Group or topic
        <select
          value={manual ? 'manual' : value}
          disabled={disabled}
          onChange={event => {
            setManual(event.target.value === 'manual');
            onChange(event.target.value === 'manual' ? '' : event.target.value);
          }}
          required
        >
          <option value="">Choose a destination…</option>
          {[...options].map(id => (
            <option key={id} value={id}>
              {destinationName(id, nodes)} · {id}
            </option>
          ))}
          <option value="manual">Enter a conversation ID…</option>
        </select>
      </label>
      {manual && (
        <label>
          Conversation ID
          <input
            value={value}
            onChange={event => onChange(event.target.value)}
            placeholder="-10042 or -10042/topic/7"
            required
            disabled={disabled}
          />
        </label>
      )}
      {value && <small>Exact destination: {value}</small>}
      <ResourceState {...spaces} hasData={!!spaces.data} />
      <CursorButtons pages={pages} next={spaces.data?.next} onChange={setPages} />
    </div>
  );
}
function ManualGrant({
  fact,
  nodes,
  initialDestination = '',
  onChanged = () => {},
}: {
  fact: MapNode;
  nodes: MapNode[];
  initialDestination?: string;
  onChanged?: (message?: string) => void;
}) {
  const [destination, setDestination] = useState(initialDestination),
    [wording, setWording] = useState(fact.label),
    command = useOwnerCommand();
  return (
    <form
      className="owner-form memory-share-form"
      onSubmit={async event => {
        event.preventDefault();
        if (
          await command.run('/memory-access/grants', {
            fact_id: fact.id.slice(5),
            fact_revision: fact.detail?.revision,
            destination,
            wording,
          })
        )
          onChanged('Fact shared until revoked.');
      }}
    >
      <h3>Share this fact</h3>
      <p className="n-muted">
        Allow one group or topic to recall the wording below until you revoke access. Sharing with a group does not also
        share with its topics.
      </p>
      <DestinationPicker value={destination} onChange={setDestination} nodes={nodes} disabled={command.busy} />
      <label>
        Wording this conversation may use
        <textarea
          rows={4}
          maxLength={12000}
          value={wording}
          onChange={event => setWording(event.target.value)}
          required
          disabled={command.busy}
        />
      </label>
      <p className="memory-share-summary">
        <ShieldCheck size={18} aria-hidden="true" />
        <span>
          {destination
            ? `Will be shared with ${destinationName(destination, nodes)} until revoked.`
            : 'Choose who can use this fact.'}{' '}
          Only this wording is shared; original evidence stays private.
        </span>
      </p>
      {command.error && <Alert>{command.error}</Alert>}
      <Button
        type="submit"
        variant="default"
        disabled={command.busy || !destination.trim() || !wording.trim() || !shareableFact(fact)}
      >
        {command.busy ? 'Sharing…' : 'Share until revoked'}
      </Button>
    </form>
  );
}
function FactEditor({
  claimId,
  label,
  detail,
  onChanged,
}: {
  claimId: string;
  label: string;
  detail: Record<string, any>;
  onChanged: () => void;
}) {
  const [content, setContent] = useState(String(detail.content ?? label)),
    [attribution, setAttribution] = useState(String(detail.attribution ?? 'inferred')),
    [uncertainty, setUncertainty] = useState(String(detail.uncertainty ?? 'supported')),
    [relationshipKind, setRelationshipKind] = useState(String(detail.relationship_kind ?? '')),
    command = useOwnerCommand();
  const save = async (retired: boolean) => {
    if (
      await command.run('/entities/claims/' + claimId + '/correct', {
        content,
        attribution,
        uncertainty,
        retired,
        expected_revision: detail.revision,
        ...(detail.relationship_kind ? {relationship_kind: relationshipKind} : {}),
      })
    )
      onChanged();
  };
  return (
    <form
      className="owner-form"
      onSubmit={event => {
        event.preventDefault();
        void save(false);
      }}
    >
      <h3>Edit memory fact</h3>
      <label>
        Exact wording
        <textarea
          rows={5}
          maxLength={8000}
          value={content}
          onChange={event => setContent(event.target.value)}
          required
        />
      </label>
      {detail.relationship_kind && (
        <label>
          Relationship type
          <select value={relationshipKind} onChange={event => setRelationshipKind(event.target.value)}>
            <option value="contextual">Contextual</option>
            <option value="participates">Participates</option>
            <option value="responsible">Responsible</option>
            <option value="depends_on">Depends on</option>
            <option value="associated">Associated</option>
          </select>
        </label>
      )}
      <div className="search-toolbar">
        <label>
          Attribution
          <select value={attribution} onChange={event => setAttribution(event.target.value)}>
            <option value="direct">Direct</option>
            <option value="reported">Reported</option>
            <option value="inferred">Inferred</option>
          </select>
        </label>
        <label>
          Confidence
          <select value={uncertainty} onChange={event => setUncertainty(event.target.value)}>
            <option value="uncertain">Uncertain</option>
            <option value="supported">Supported</option>
            <option value="explicit">Explicit</option>
          </select>
        </label>
      </div>
      {command.error && <Alert>{command.error}</Alert>}
      <div className="n-actions">
        <Button type="submit" variant="default" disabled={command.busy || !content.trim()}>
          Save correction
        </Button>
        <Button type="button" variant="destructive" disabled={command.busy} onClick={() => void save(true)}>
          Retire fact
        </Button>
      </div>
    </form>
  );
}
function PersonEditor({node, onChanged}: {node: MapNode; onChanged: () => void}) {
  const [name, setName] = useState(node.label),
    command = useOwnerCommand();
  return (
    <form
      className="owner-form"
      onSubmit={async event => {
        event.preventDefault();
        if (
          await command.run('/entities/' + node.id.slice(7) + '/rename', {
            name,
            expected_revision: node.detail?.revision,
          })
        )
          onChanged();
      }}
    >
      <h3>Edit person</h3>
      <label>
        Display name
        <input maxLength={200} value={name} onChange={event => setName(event.target.value)} required />
      </label>
      <p className="n-muted">
        This changes the owner-facing name. Confirmed source identities and evidence stay attached.
      </p>
      {command.error && <Alert>{command.error}</Alert>}
      <Button type="submit" variant="default" disabled={command.busy || !name.trim()}>
        Save name
      </Button>
    </form>
  );
}
function ProjectEditor({node, onChanged}: {node: MapNode; onChanged: () => void}) {
  const project = (node.detail?.project ?? {
      id: node.detail?.project_id,
      name: node.label,
      description: '',
      state: node.state ?? 'active',
      revision: 1,
    }) as Project,
    [name, setName] = useState(project.name),
    [description, setDescription] = useState(project.description),
    [state, setState] = useState(project.state),
    command = useOwnerCommand();
  return (
    <form
      className="owner-form"
      onSubmit={async event => {
        event.preventDefault();
        if (
          await command.run('/projects', {
            id: project.id,
            name,
            description,
            state,
            expected_revision: project.revision,
          })
        )
          onChanged();
      }}
    >
      <h3>Edit project</h3>
      <label>
        Name
        <input maxLength={200} value={name} onChange={event => setName(event.target.value)} required />
      </label>
      <label>
        Description
        <textarea
          rows={4}
          maxLength={4000}
          value={description}
          onChange={event => setDescription(event.target.value)}
        />
      </label>
      <label>
        State
        <select value={state} onChange={event => setState(event.target.value as Project['state'])}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </label>
      {command.error && <Alert>{command.error}</Alert>}
      <Button type="submit" variant="default" disabled={command.busy || !name.trim()}>
        Save project
      </Button>
    </form>
  );
}
function AssignmentEditor({
  destination,
  assignment,
  projectId,
  onChanged,
}: {
  destination: string;
  assignment?: Assignment | null;
  projectId?: string;
  onChanged: () => void;
}) {
  const projects = useResource<{projects: Project[]}>('/projects?after='),
    [mode, setMode] = useState<Assignment['mode']>(
      projectId ? 'assigned' : (assignment?.mode ?? (destination.includes('/topic/') ? 'inherit' : 'none')),
    ),
    [project, setProject] = useState(projectId ?? assignment?.project_id ?? ''),
    command = useOwnerCommand();
  return (
    <form
      className="owner-form"
      onSubmit={async event => {
        event.preventDefault();
        if (
          await command.run('/projects/assignments', {
            space_id: destination,
            mode,
            project_id: mode === 'assigned' ? project : null,
            expected_revision: assignment?.revision ?? 0,
          })
        )
          onChanged();
      }}
    >
      <h3>Edit project assignment</h3>
      <p className="n-muted">Project assignment organizes this scope. It never grants memory access.</p>
      <label>
        Assignment
        <select value={mode} onChange={event => setMode(event.target.value as Assignment['mode'])}>
          <option value="assigned">Assigned project</option>
          <option value="none">No project</option>
          {destination.includes('/topic/') && <option value="inherit">Inherit from conversation</option>}
        </select>
      </label>
      {mode === 'assigned' && (
        <label>
          Project
          <select value={project} onChange={event => setProject(event.target.value)} required>
            <option value="">Select project</option>
            {projects.data?.projects
              .filter(item => item.state === 'active')
              .map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {command.error && <Alert>{command.error}</Alert>}
      <Button type="submit" variant="default" disabled={command.busy || (mode === 'assigned' && !project)}>
        Save assignment
      </Button>
    </form>
  );
}

function EdgeDetail({
  edge,
  nodes,
  onChanged,
}: {
  edge: MapEdge;
  nodes: MapNode[];
  onChanged: (message?: string) => void;
}) {
  const command = useOwnerCommand(),
    detail = edge.detail ?? {},
    factEndpoint = [edge.source, edge.target].find(id => /^fact:[a-f0-9]{64}$/.test(id)),
    claimId =
      detail.claim_id ?? edge.id.match(/^relationship:(?:fact:)?([a-f0-9]{64})$/)?.[1] ?? factEndpoint?.slice(5),
    fact = claimId ? nodes.find(node => node.id === 'fact:' + claimId) : null,
    claimDetail: Record<string, any> = {...(fact?.detail ?? {}), ...detail, content: detail.content ?? fact?.label};
  if (edge.kind === 'relationship' && claimId)
    return (
      <>
        <FactEditor
          claimId={claimId}
          label={claimDetail.content ?? edge.label ?? ''}
          detail={claimDetail}
          onChanged={onChanged}
        />
        <EvidenceLinks sources={claimDetail.evidence ?? []} />
        {claimDetail.history && (
          <p>
            <a href={String(claimDetail.history).replace(/^\/v1/, '/api/nocheh')} target="_blank" rel="noreferrer">
              Open correction history
            </a>
          </p>
        )}
        <Provenance value={edge} label="Technical details" />
      </>
    );
  if (edge.kind === 'project_assignment')
    return (
      <>
        <AssignmentEditor
          destination={detail.destination ?? edge.target.replace(/^(conversation|topic):/, '')}
          assignment={{
            space_id: detail.destination,
            project_id: detail.project_id,
            mode: detail.mode,
            revision: detail.revision,
          }}
          onChanged={onChanged}
        />
        <Provenance value={edge} label="Technical details" />
      </>
    );
  if (edge.kind === 'suggestion')
    return (
      <RequestRow
        nodes={nodes}
        item={{
          id: detail.request_id,
          destination: detail.destination,
          state: edge.state ?? 'pending',
          revision: detail.revision,
          expires_at: detail.expires_at,
          wording: detail.wording,
          relationship_path: detail.relationship_path ?? [],
          evidence: detail.evidence ?? [],
          provenance: detail.provenance,
        }}
        onChanged={onChanged}
      />
    );
  return (
    <>
      <p>{connectionDescription(edge)}</p>
      <p className="memory-prose">{detail.wording}</p>
      {detail.destination && (
        <p>
          <strong>Destination</strong> {detail.destination}
        </p>
      )}
      {edge.kind === 'access' && detail.grant_id && ['active', 'suspended'].includes(edge.state ?? '') && (
        <Button
          variant="destructive"
          disabled={command.busy}
          onClick={async () => {
            if (
              await command.run('/memory-access/grants/' + detail.grant_id + '/revoke', {
                expected_revision: detail.revision,
              })
            )
              onChanged();
          }}
        >
          Revoke access
        </Button>
      )}
      {command.error && <Alert>{command.error}</Alert>}
      <Provenance value={edge} label="Technical details" />
    </>
  );
}
function NodeDetail({
  node,
  nodes,
  edges,
  onSelect,
  onChanged,
}: {
  node: MapNode;
  nodes: MapNode[];
  edges: MapEdge[];
  onSelect: (value: Selection) => void;
  onChanged: (message?: string) => void;
}) {
  const detail = node.detail ?? {},
    claim = /^fact:[a-f0-9]{64}$/.test(node.id) ? node.id.slice(5) : null,
    related = edges.filter(edge => edge.source === node.id || edge.target === node.id);
  return (
    <>
      <div className="memory-detail-label">
        <Badge>{kindLabels[node.kind]}</Badge>
        {node.state && <Badge>{node.state}</Badge>}
      </div>
      {node.kind === 'person' && <PersonEditor node={node} onChanged={onChanged} />}{' '}
      {node.kind === 'project' && <ProjectEditor node={node} onChanged={onChanged} />}{' '}
      {(node.kind === 'conversation' || node.kind === 'topic') && (
        <AssignmentEditor destination={detail.space_id} assignment={detail.assignment} onChanged={onChanged} />
      )}{' '}
      {claim && (
        <Tabs defaultValue="details">
          <TabsList aria-label="Memory fact actions">
            <TabsTrigger value="details">Edit fact</TabsTrigger>
            {shareableFact(node) && <TabsTrigger value="share">Share fact</TabsTrigger>}
          </TabsList>
          <TabsContent value="details">
            <FactEditor claimId={claim} label={node.label} detail={detail} onChanged={onChanged} />
            <EvidenceLinks sources={detail.evidence ?? []} />
          </TabsContent>
          <TabsContent value="share">
            <ManualGrant fact={node} nodes={nodes} onChanged={onChanged} />
          </TabsContent>
        </Tabs>
      )}
      {related.length > 0 && (
        <section className="memory-detail-connections">
          <h3>Connected to this record</h3>
          <ConnectionList edges={related} nodes={nodes} onSelect={onSelect} />
        </section>
      )}
      <Provenance value={node} label="Technical details" />
    </>
  );
}

export function MemoryMap() {
  const [query, setQuery] = useState(''),
    deferredQuery = useDeferredValue(query),
    [kind, setKind] = useState(''),
    [state, setState] = useState(''),
    [pages, setPages] = useState(['']),
    [showFacts, setShowFacts] = useState(false),
    [view, setView] = useState<MemoryMapView>('list'),
    [selected, setSelected] = useState<Selection | null>(null),
    [revision, setRevision] = useState(0),
    [notice, setNotice] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const params = new URLSearchParams({
      after: pages.at(-1)!,
      limit: '180',
      q: deferredQuery,
      ...(kind ? {kind} : {}),
      ...(state ? {state} : {}),
    }),
    data = useResource<MapData>('/memory-map?' + params, 0, revision),
    directory = useResource<MapData>('/memory-map?limit=250'),
    factsVisible = showFacts || kind === 'fact',
    pageFacts = data.data?.nodes.filter(node => node.kind === 'fact').length ?? 0,
    shownNodes = data.data?.nodes.filter(node => factsVisible || node.kind !== 'fact') ?? [],
    shownIds = new Set(shownNodes.map(node => node.id)),
    shownEdges = data.data?.edges.filter(edge => shownIds.has(edge.source) && shownIds.has(edge.target)).length ?? 0,
    hasFilters = !!(query || kind || state),
    searching = query !== deferredQuery;
  const knownNodes = useMemo(
    () => [
      ...new Map([...(directory.data?.nodes ?? []), ...(data.data?.nodes ?? [])].map(node => [node.id, node])).values(),
    ],
    [directory.data, data.data],
  );
  const select = useCallback((value: Selection) => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[role="dialog"]'))
      returnFocus.current = document.activeElement;
    setSelected(value);
  }, []);
  const changed = (message = 'Changes saved.') => {
    setSelected(null);
    setNotice(message);
    setRevision(value => value + 1);
  };
  const title =
      selected?.type === 'node'
        ? selected.value.label
        : selected?.type === 'edge'
          ? edgeLabels[selected.value.kind]
          : selected?.fact
            ? 'Share this fact'
            : 'Assign project',
    description =
      selected?.type === 'edge'
        ? connectionDescription(selected.value)
        : selected?.type === 'connect'
          ? 'Review and save the connection. Drawing it did not change memory or access.'
          : 'Review this record and its connections. Changes take effect when you save.';
  const clearFilters = () => {
    setQuery('');
    setKind('');
    setState('');
    setPages(['']);
  };
  const mapStatus = data.data
    ? `${countLabel(shownNodes.length, 'item')} shown · ${countLabel(shownEdges, 'connection')} shown${!factsVisible && pageFacts ? ` · ${countLabel(pageFacts, 'fact')} hidden` : ''}`
    : 'Loading memory map';
  return (
    <section className="n-panel memory-relations-page">
      <div className="memory-relations-heading">
        <div>
          <h2>People, projects & facts</h2>
          <p className="n-muted">
            Explore what Nocheh knows and how it connects. Who may use which facts is managed in{' '}
            <a href="#access">Chats &amp; access</a>.
          </p>
        </div>
        <Badge>
          <ShieldCheck size={13} aria-hidden="true" />
          Owner only
        </Badge>
      </div>
      <p className="memory-privacy-note">
        <ShieldCheck size={18} aria-hidden="true" />
        <span>
          Relationships and projects organize memory.{' '}
          <strong>Only approved sharing gives another conversation access.</strong>
        </span>
      </p>
      {notice && (
        <p className="memory-save-notice" role="status">
          {notice}
        </p>
      )}
      <div className="memory-explore-toolbar">
        <form
          className="memory-map-filters"
          role="search"
          onSubmit={event => event.preventDefault()}
          aria-label="Filter the memory map"
        >
          <label className="memory-map-search">
            <span>Search memory</span>
            <span className="memory-map-input-wrap">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={event => {
                  setQuery(event.target.value);
                  setPages(['']);
                }}
                placeholder="Person, project, conversation or fact…"
              />
            </span>
          </label>
          <label>
            <span>Record type</span>
            <select
              value={kind}
              onChange={event => {
                setKind(event.target.value);
                setPages(['']);
              }}
            >
              <option value="">All records</option>
              <option value="person">People</option>
              <option value="project">Projects</option>
              <option value="conversation">Conversations</option>
              <option value="topic">Topics</option>
              <option value="fact">Facts</option>
            </select>
          </label>
          <label>
            <span>Status</span>
            <select
              value={state}
              onChange={event => {
                setState(event.target.value);
                setPages(['']);
              }}
            >
              <option value="">Any status</option>
              {[
                'active',
                'pending',
                'suspended',
                'retired',
                'archived',
                'revoked',
                'expired',
                'consumed',
                'approved',
                'rejected',
              ].map(value => (
                <option key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </form>
      </div>
      <div className="memory-explore-heading">
        <div>
          <h3>{view === 'map' ? 'Relationship map' : 'People, projects & facts'}</h3>
          <p className="n-muted">
            {view === 'map'
              ? 'Drag cards to arrange them. Select a card or connection for details.'
              : 'Open a record to edit it, see its connections, or share a fact.'}
          </p>
        </div>
        <div className="memory-map-view-switch" role="group" aria-label="Memory map view">
          <Button
            size="sm"
            variant={view === 'list' ? 'default' : 'outline'}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            <List size={15} aria-hidden="true" />
            List
          </Button>
          <Button
            size="sm"
            variant={view === 'map' ? 'default' : 'outline'}
            aria-pressed={view === 'map'}
            onClick={() => setView('map')}
          >
            <MapIcon size={15} aria-hidden="true" />
            Map
          </Button>
        </div>
      </div>
      <div className="memory-results-status">
        <span role="status">
          {searching
            ? 'Updating results…'
            : data.data
              ? view === 'map'
                ? mapStatus
                : `${data.data.nodes.length} records shown · ${data.data.counts.nodes} matching`
              : 'Loading records…'}
        </span>
        <div>
          {view === 'map' && (
            <Button
              size="sm"
              aria-pressed={factsVisible}
              disabled={kind === 'fact'}
              onClick={() => setShowFacts(value => !value)}
            >
              {kind === 'fact' ? 'Facts selected' : showFacts ? 'Hide facts from map' : 'Show facts on map'}
            </Button>
          )}
          {hasFilters && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      </div>
      <ResourceState {...data} hasData={!!data.data} />
      {data.data && (
        <div className="memory-map-workspace">
          {view === 'map' ? (
            shownNodes.length ? (
              <GraphView data={data.data} showFacts={factsVisible} onSelect={select} onConnectEdit={select} />
            ) : (
              <EmptyState title="Nothing to draw">
                Show facts on the map or clear a filter to restore connected records.
              </EmptyState>
            )
          ) : (
            <MemoryList nodes={data.data.nodes} edges={data.data.edges} onSelect={select} />
          )}
          <div className="memory-map-workspace-footer">
            <span>
              {data.data.next
                ? 'More records available. Connections may continue on another page.'
                : pages.length > 1
                  ? 'Last page of matching records.'
                  : 'All matching records shown.'}
            </span>
            <CursorButtons pages={pages} next={data.data.next} onChange={setPages} />
          </div>
        </div>
      )}
      {view === 'map' && (
        <details className="memory-map-help">
          <summary>How to use this map</summary>
          <MapLegend />
          <p className="memory-map-instruction">
            Connect a fact to a conversation or topic to prepare a share, or a project to a conversation to prepare an
            assignment. Every change opens for review before it is saved. You can also open a fact and choose Share fact
            without dragging.
          </p>
        </details>
      )}
      <Sheet
        open={!!selected}
        onOpenChange={open => {
          if (!open) setSelected(null);
        }}
        title={title ?? 'Memory detail'}
        description={description}
        returnFocus={returnFocus.current}
      >
        <div key={selected?.type === 'connect' ? `connect:${selected.destination.id}` : selected?.value.id}>
          {selected?.type === 'node' && (
            <NodeDetail
              node={selected.value}
              nodes={knownNodes}
              edges={data.data?.edges ?? []}
              onSelect={select}
              onChanged={changed}
            />
          )}{' '}
          {selected?.type === 'edge' && <EdgeDetail edge={selected.value} nodes={knownNodes} onChanged={changed} />}{' '}
          {selected?.type === 'connect' && selected.fact && (
            <ManualGrant
              fact={selected.fact}
              nodes={knownNodes}
              initialDestination={selected.destination.detail?.space_id}
              onChanged={changed}
            />
          )}{' '}
          {selected?.type === 'connect' && selected.project && (
            <AssignmentEditor
              destination={selected.destination.detail?.space_id}
              assignment={selected.destination.detail?.assignment}
              projectId={selected.project.detail?.project_id}
              onChanged={changed}
            />
          )}
        </div>
      </Sheet>
    </section>
  );
}
