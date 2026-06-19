import type { ProcessingAuditRecord } from "../../domain/observability/audit.js";

/** Stores processing audit records for developer and operator diagnostics. */
export interface AuditRepositoryPort {
  save(record: ProcessingAuditRecord): Promise<void>;
  findRecent(limit: number): Promise<readonly ProcessingAuditRecord[]>;
}

/** No-op audit repository for tests or deployments without audit persistence. */
export class NoopAuditRepository implements AuditRepositoryPort {
  public async save(): Promise<void> {}
  public async findRecent(): Promise<readonly ProcessingAuditRecord[]> {
    return [];
  }
}
