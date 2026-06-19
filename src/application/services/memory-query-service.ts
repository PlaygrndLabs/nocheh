import type { MemoryRecordRepositoryPort } from "../ports/memory-record-repository.js";
import type { MemoryRetrievalPort } from "../ports/memory-retrieval.js";
import type { MemoryRecord } from "../../domain/memory/memory-record.js";
import { projectIdFromName } from "../../domain/memory/memory-record.js";

/** Read-side service for common Chief-of-Staff memory questions. */
export class MemoryQueryService {
  public constructor(
    private readonly repository: MemoryRecordRepositoryPort,
    private readonly retrieval: MemoryRetrievalPort,
  ) {}

  /** Answers "What decisions were made?" */
  public async decisions(projectName?: string): Promise<readonly MemoryRecord[]> {
    const records = projectName === undefined
      ? await this.repository.findByType("Decision")
      : await this.repository.findByProjectId(projectIdFromName(projectName));

    return records
      .filter((record) => record.type === "Decision")
      .sort(newestFirst);
  }

  /** Answers "What blockers exist?" */
  public async openBlockers(projectName?: string): Promise<readonly MemoryRecord[]> {
    const records = projectName === undefined
      ? await this.repository.findByType("Blocker")
      : await this.repository.findByProjectId(projectIdFromName(projectName));

    return records
      .filter((record) => record.type === "Blocker" && record.blocker?.status === "open")
      .sort(newestFirst);
  }

  /** Answers "What is the status of project X?" from structured records. */
  public async projectStatus(projectName: string): Promise<readonly MemoryRecord[]> {
    return this.retrieval.query({
      text: projectName,
      projectId: projectIdFromName(projectName),
      limit: 10,
      minimumScore: 0,
    }).then((results) => results.map((result) => result.record).sort(newestFirst));
  }
}

function newestFirst(left: MemoryRecord, right: MemoryRecord): number {
  return right.timestamp.getTime() - left.timestamp.getTime();
}
