import type { MemoryGraphRepositoryPort } from "../../application/ports/memory-graph-repository.js";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryGraphSource,
  MemoryNode,
  MemoryNodeId,
  MemoryRelation,
} from "../../domain/memory/memory-graph.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface NodeRow {
  readonly id: string;
  readonly kind: MemoryNode["kind"];
  readonly label: string;
  readonly scope: MemoryNode["scope"];
  readonly status: MemoryNode["status"];
  readonly confidence: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly source: string;
  readonly aliases: string;
  readonly summary: string | null;
  readonly payload: string;
}

interface EdgeRow {
  readonly id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly relation: MemoryRelation;
  readonly status: MemoryEdge["status"];
  readonly confidence: number;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly source: string;
  readonly fact: string;
  readonly payload: string;
}

type StoredSource = Omit<MemoryGraphSource, "occurredAt"> & { readonly occurredAt: string };

export class SqliteMemoryGraphRepository implements MemoryGraphRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async saveNode(node: MemoryNode): Promise<void> {
    this.database.prepare(`
      INSERT INTO memory_nodes (
        id, kind, label, scope, status, confidence, created_at, updated_at, source, aliases, summary, payload
      )
      VALUES (
        @id, @kind, @label, @scope, @status, @confidence, @createdAt, @updatedAt, @source, @aliases, @summary, @payload
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        label = excluded.label,
        scope = excluded.scope,
        status = excluded.status,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at,
        source = excluded.source,
        aliases = excluded.aliases,
        summary = excluded.summary,
        payload = excluded.payload
    `).run({
      id: node.id,
      kind: node.kind,
      label: node.label,
      scope: node.scope,
      status: node.status,
      confidence: node.confidence,
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
      source: await this.codec.encode(this.serializeSource(node.source)),
      aliases: await this.codec.encode(node.aliases),
      summary: node.summary === undefined ? null : await this.codec.encode(node.summary),
      payload: await this.codec.encode(node.payload),
    });
  }

  public async saveEdge(edge: MemoryEdge): Promise<void> {
    this.database.prepare(`
      INSERT INTO memory_edges (
        id, from_node_id, to_node_id, relation, status, confidence, valid_from, valid_until,
        created_at, updated_at, source, fact, payload
      )
      VALUES (
        @id, @fromNodeId, @toNodeId, @relation, @status, @confidence, @validFrom, @validUntil,
        @createdAt, @updatedAt, @source, @fact, @payload
      )
      ON CONFLICT(id) DO UPDATE SET
        from_node_id = excluded.from_node_id,
        to_node_id = excluded.to_node_id,
        relation = excluded.relation,
        status = excluded.status,
        confidence = excluded.confidence,
        valid_from = excluded.valid_from,
        valid_until = excluded.valid_until,
        updated_at = excluded.updated_at,
        source = excluded.source,
        fact = excluded.fact,
        payload = excluded.payload
    `).run({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      relation: edge.relation,
      status: edge.status,
      confidence: edge.confidence,
      validFrom: edge.validFrom?.toISOString() ?? null,
      validUntil: edge.validUntil?.toISOString() ?? null,
      createdAt: edge.createdAt.toISOString(),
      updatedAt: edge.updatedAt.toISOString(),
      source: await this.codec.encode(this.serializeSource(edge.source)),
      fact: await this.codec.encode(edge.fact),
      payload: await this.codec.encode(edge.payload),
    });
  }

  public async findNodeById(id: MemoryNodeId): Promise<MemoryNode | undefined> {
    const row = this.database.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row === undefined ? undefined : this.deserializeNode(row);
  }

  public async findEdgeById(id: MemoryEdgeId): Promise<MemoryEdge | undefined> {
    const row = this.database.prepare("SELECT * FROM memory_edges WHERE id = ?").get(id) as EdgeRow | undefined;
    return row === undefined ? undefined : this.deserializeEdge(row);
  }

  public async listNodes(): Promise<readonly MemoryNode[]> {
    return Promise.all((this.database.prepare("SELECT * FROM memory_nodes ORDER BY updated_at DESC").all() as NodeRow[])
      .map((row) => this.deserializeNode(row)));
  }

  public async listEdgesForNode(nodeId: MemoryNodeId): Promise<readonly MemoryEdge[]> {
    return Promise.all((this.database
      .prepare("SELECT * FROM memory_edges WHERE from_node_id = ? OR to_node_id = ? ORDER BY updated_at DESC")
      .all(nodeId, nodeId) as EdgeRow[]).map((row) => this.deserializeEdge(row)));
  }

  public async listEdgesByRelation(relation: MemoryRelation): Promise<readonly MemoryEdge[]> {
    return Promise.all((this.database
      .prepare("SELECT * FROM memory_edges WHERE relation = ? ORDER BY updated_at DESC")
      .all(relation) as EdgeRow[]).map((row) => this.deserializeEdge(row)));
  }

  private async deserializeNode(row: NodeRow): Promise<MemoryNode> {
    const summary = row.summary === null ? undefined : await this.codec.decode<string>(row.summary);
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      scope: row.scope,
      status: row.status,
      confidence: row.confidence,
      source: this.deserializeSource(await this.codec.decode<StoredSource>(row.source)),
      aliases: await this.codec.decode<readonly string[]>(row.aliases),
      payload: await this.codec.decode<MemoryNode["payload"]>(row.payload),
      ...(summary === undefined ? {} : { summary }),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private async deserializeEdge(row: EdgeRow): Promise<MemoryEdge> {
    return {
      id: row.id,
      fromNodeId: row.from_node_id,
      toNodeId: row.to_node_id,
      relation: row.relation,
      fact: await this.codec.decode<string>(row.fact),
      source: this.deserializeSource(await this.codec.decode<StoredSource>(row.source)),
      confidence: row.confidence,
      status: row.status,
      payload: await this.codec.decode<MemoryEdge["payload"]>(row.payload),
      ...(row.valid_from === null ? {} : { validFrom: new Date(row.valid_from) }),
      ...(row.valid_until === null ? {} : { validUntil: new Date(row.valid_until) }),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private serializeSource(source: MemoryGraphSource): StoredSource {
    return {
      ...source,
      occurredAt: source.occurredAt.toISOString(),
    };
  }

  private deserializeSource(source: StoredSource): MemoryGraphSource {
    return {
      ...source,
      occurredAt: new Date(source.occurredAt),
    };
  }
}
