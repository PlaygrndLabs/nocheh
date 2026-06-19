import type { ExtractedTaskCandidate } from "../../domain/tasks/task-extraction.js";
import type { IncomingMessage } from "../../application/dto/incoming-message.js";
import type { TaskExtractorPort } from "../../application/ports/task-extractor.js";
import type { TaskPriority } from "../../domain/tasks/task.js";

/** Deterministic Phase 1 extractor for explicit task language in sanitized messages. */
export class RuleBasedTaskExtractor implements TaskExtractorPort {
  /** Extracts candidate tasks from common action-item formats. */
  public async extractTasks(message: IncomingMessage): Promise<readonly ExtractedTaskCandidate[]> {
    const candidates = message.text
      .split(/\r?\n/)
      .map((line) => this.extractFromLine(line.trim()))
      .filter((candidate): candidate is ExtractedTaskCandidate => candidate !== undefined);

    return candidates;
  }

  private extractFromLine(line: string): ExtractedTaskCandidate | undefined {
    const normalized = line.replace(/^[-*]\s*/, "").trim();
    const explicit = /^(?:todo|task|action item|ai)\s*[:\-]\s*(.+)$/i.exec(normalized);
    const assignment = /^(?:please\s+)?(?:can you|could you|we need to|need to|let's|todo)\s+(.+)$/i.exec(normalized);

    const body = explicit?.[1] ?? assignment?.[1];
    if (body === undefined) {
      return undefined;
    }

    const dueAt = this.extractDueDate(body);
    const priority = this.extractPriority(body);
    return {
      title: this.cleanTitle(body),
      ...(dueAt === undefined ? {} : { dueAt }),
      priority,
      confidence: explicit === null ? 0.72 : 0.9,
    };
  }

  private cleanTitle(text: string): string {
    return text
      .replace(/\b(?:by|before|due)\s+(today|tomorrow|\d{4}-\d{2}-\d{2})\b/gi, "")
      .replace(/\b(?:urgent|asap|high priority|low priority)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.!?]$/, "");
  }

  private extractPriority(text: string): TaskPriority {
    if (/\b(?:urgent|asap)\b/i.test(text)) {
      return "urgent";
    }
    if (/\bhigh priority\b/i.test(text)) {
      return "high";
    }
    if (/\blow priority\b/i.test(text)) {
      return "low";
    }
    return "medium";
  }

  private extractDueDate(text: string): Date | undefined {
    const iso = /\b(?:by|before|due)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text);
    if (iso?.[1] !== undefined) {
      return new Date(`${iso[1]}T23:59:59.000Z`);
    }
    return undefined;
  }
}
