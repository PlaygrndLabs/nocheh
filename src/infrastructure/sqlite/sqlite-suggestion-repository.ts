import type { SuggestionRepositoryPort } from "../../application/ports/suggestion-repository.js";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import type {
  ActionSuggestion,
  StrategicSuggestion,
  Suggestion,
  SuggestionId,
  SuggestionStatus,
} from "../../domain/memory/strategic-suggestion.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface SuggestionRow {
  readonly id: string;
  readonly payload: string;
}

type JsonRecord = Record<string, unknown>;

export class SqliteSuggestionRepository implements SuggestionRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async save(suggestion: Suggestion): Promise<void> {
    this.database.prepare(`
      INSERT INTO suggestions (
        id, type, kind, title, status, risk_level, confidence, created_at, updated_at, source, rationale, payload
      )
      VALUES (
        @id, @type, @kind, @title, @status, @riskLevel, @confidence, @createdAt, @updatedAt, @source, @rationale, @payload
      )
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        kind = excluded.kind,
        title = excluded.title,
        status = excluded.status,
        risk_level = excluded.risk_level,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at,
        source = excluded.source,
        rationale = excluded.rationale,
        payload = excluded.payload
    `).run({
      id: suggestion.id,
      type: suggestion.type,
      kind: suggestion.kind,
      title: suggestion.title,
      status: suggestion.status,
      riskLevel: suggestion.riskLevel,
      confidence: suggestion.confidence,
      createdAt: suggestion.createdAt.toISOString(),
      updatedAt: suggestion.updatedAt.toISOString(),
      source: await this.codec.encode({
        ...suggestion.source,
        occurredAt: suggestion.source.occurredAt.toISOString(),
      }),
      rationale: await this.codec.encode(suggestion.rationale),
      payload: await this.codec.encode(JSON.parse(JSON.stringify(suggestion))),
    });
  }

  public async findById(id: SuggestionId): Promise<Suggestion | undefined> {
    const row = this.database.prepare("SELECT id, payload FROM suggestions WHERE id = ?").get(id) as SuggestionRow | undefined;
    return row === undefined ? undefined : this.deserialize(row);
  }

  public async findByStatus(status: SuggestionStatus): Promise<readonly Suggestion[]> {
    return this.decodeRows(this.database
      .prepare("SELECT id, payload FROM suggestions WHERE status = ? ORDER BY updated_at DESC")
      .all(status) as SuggestionRow[]);
  }

  public async findPending(): Promise<readonly Suggestion[]> {
    return this.findByStatus("pending");
  }

  private async decodeRows(rows: readonly SuggestionRow[]): Promise<readonly Suggestion[]> {
    return Promise.all(rows.map((row) => this.deserialize(row)));
  }

  private async deserialize(row: SuggestionRow): Promise<Suggestion> {
    const payload = await this.codec.decode<JsonRecord>(row.payload);
    return hydrateSuggestion(payload);
  }
}

function hydrateSuggestion(payload: JsonRecord): Suggestion {
  hydrateDate(payload, "createdAt");
  hydrateDate(payload, "updatedAt");
  hydrateDate(payload, "acceptedAt");
  hydrateDate(payload, "rejectedAt");
  hydrateDate(payload, "archivedAt");
  hydrateDate(payload, "convertedAt");
  hydrateSource(payload);

  if (payload.type === "strategic") {
    hydrateProposedNode(payload);
    hydrateProposedEdges(payload);
    return payload as unknown as StrategicSuggestion;
  }

  return payload as unknown as ActionSuggestion;
}

function hydrateDate(payload: JsonRecord, key: string): void {
  const value = payload[key];
  if (typeof value === "string") {
    payload[key] = new Date(value);
  }
}

function hydrateSource(payload: JsonRecord): void {
  const source = payload.source;
  if (isRecord(source) && typeof source.occurredAt === "string") {
    source.occurredAt = new Date(source.occurredAt);
  }
}

function hydrateProposedNode(payload: JsonRecord): void {
  const proposedNode = payload.proposedNode;
  if (!isRecord(proposedNode)) {
    return;
  }
  hydrateSource(proposedNode);
  hydrateDate(proposedNode, "now");
}

function hydrateProposedEdges(payload: JsonRecord): void {
  if (!Array.isArray(payload.proposedEdges)) {
    return;
  }
  for (const edge of payload.proposedEdges) {
    if (!isRecord(edge)) {
      continue;
    }
    hydrateSource(edge);
    hydrateDate(edge, "validFrom");
    hydrateDate(edge, "validUntil");
    hydrateDate(edge, "now");
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
