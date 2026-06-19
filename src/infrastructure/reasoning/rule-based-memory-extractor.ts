import type { IncomingMessage } from "../../application/dto/incoming-message.js";
import type { ExtractedMemoryCandidate, MemoryExtractorPort } from "../../application/ports/memory-extractor.js";
import { projectIdFromName, type ProjectReference } from "../../domain/memory/memory-record.js";

/** Deterministic Phase 2 extractor for structured memory from sanitized messages. */
export class RuleBasedMemoryExtractor implements MemoryExtractorPort {
  /** Extracts decisions, projects, blockers, deadlines, and summaries without retaining raw text. */
  public async extractMemory(message: IncomingMessage): Promise<readonly ExtractedMemoryCandidate[]> {
    const project = this.extractProjectReference(message.text);
    const candidates: ExtractedMemoryCandidate[] = [];

    if (project !== undefined) {
      const description = this.extractProjectDescription(message.text, project.name);
      candidates.push({
        type: "Project",
        project,
        projectMemory: {
          name: project.name,
          ...(description === undefined ? {} : { description }),
        },
        confidence: 0.82,
        extractionReason: "Detected explicit project context.",
      });
    }

    for (const line of message.text.split(/\r?\n/).map((candidate) => candidate.trim()).filter(Boolean)) {
      const decision = this.extractDecision(line, project);
      if (decision !== undefined) {
        candidates.push(decision);
      }

      const blocker = this.extractBlocker(line, project);
      if (blocker !== undefined) {
        candidates.push(blocker);
      }

      const deadline = this.extractDeadline(line, project);
      if (deadline !== undefined) {
        candidates.push(deadline);
      }

      const summary = this.extractSummary(line, project);
      if (summary !== undefined) {
        candidates.push(summary);
      }
    }

    return this.dedupe(candidates);
  }

  private extractProjectReference(text: string): ProjectReference | undefined {
    const match = /\b(?:project|proj)\s*[:#-]\s*([A-Z][A-Za-z0-9 _]{1,60}?)(?:\s*[-:]\s*|[.!?\n]|$)/i.exec(text)
      ?? /\b(?:for|on|in)\s+(?:the\s+)?([A-Z][A-Za-z0-9 _-]{1,60})\s+project\b/i.exec(text);
    const name = match?.[1]?.replace(/[.!?,;:]$/, "").trim();
    return name === undefined || name.length < 2
      ? undefined
      : { id: projectIdFromName(name), name };
  }

  private extractProjectDescription(text: string, projectName: string): string | undefined {
    const marker = new RegExp(`\\bproject\\s*[:#-]\\s*${escapeRegExp(projectName)}\\b\\s*[-:]?\\s*(.+)$`, "i").exec(text);
    const description = marker?.[1]?.trim();
    return description === undefined || description.length < 8 ? undefined : this.cleanStructuredText(description);
  }

  private extractDecision(line: string, project: ProjectReference | undefined): ExtractedMemoryCandidate | undefined {
    const normalized = line.replace(/^[-*]\s*/, "").trim();
    const match = /^(?:decision|decided|we decided|agreed|approved|final call)\s*[:\-]?\s*(.+)$/i.exec(normalized)
      ?? /\b(?:we decided to|we agreed to|let'?s go with|approved)\s+(.+)$/i.exec(normalized);
    const outcome = match?.[1]?.trim();
    if (outcome === undefined || outcome.length < 5) {
      return undefined;
    }

    const cleaned = this.cleanStructuredText(outcome);
    return {
      type: "Decision",
      ...(project === undefined ? {} : { project }),
      decision: {
        title: this.toTitle(cleaned),
        outcome: cleaned,
      },
      confidence: normalized.toLowerCase().startsWith("decision") ? 0.9 : 0.76,
      extractionReason: "Matched decision language.",
    };
  }

  private extractBlocker(line: string, project: ProjectReference | undefined): ExtractedMemoryCandidate | undefined {
    const normalized = line.replace(/^[-*]\s*/, "").trim();
    const match = /^(?:blocker|blocked by|blocked on|stuck because|waiting on)\s*[:\-]?\s*(.+)$/i.exec(normalized)
      ?? /\b(?:is blocked by|are blocked by|blocked on|waiting on)\s+(.+)$/i.exec(normalized);
    const description = match?.[1]?.trim();
    if (description === undefined || description.length < 4) {
      return undefined;
    }

    return {
      type: "Blocker",
      ...(project === undefined ? {} : { project }),
      blocker: {
        description: this.cleanStructuredText(description),
        status: /\b(?:resolved|unblocked|fixed)\b/i.test(normalized) ? "resolved" : "open",
      },
      confidence: normalized.toLowerCase().startsWith("blocker") ? 0.9 : 0.72,
      extractionReason: "Matched blocker language.",
    };
  }

  private extractDeadline(line: string, project: ProjectReference | undefined): ExtractedMemoryCandidate | undefined {
    const normalized = line.replace(/^[-*]\s*/, "").trim();
    const match = /^(?:deadline|due|ship by|launch by)\s*[:\-]?\s*(.+)$/i.exec(normalized)
      ?? /\b(?:deadline is|due by|ship by|launch by)\s+(.+)$/i.exec(normalized);
    const body = match?.[1]?.trim();
    if (body === undefined || body.length < 4) {
      return undefined;
    }

    const dueAt = this.extractIsoDate(body);
    return {
      type: "Deadline",
      ...(project === undefined ? {} : { project }),
      deadline: {
        title: this.toTitle(this.cleanStructuredText(body.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""))),
        description: this.cleanStructuredText(body),
        ...(dueAt === undefined ? {} : { dueAt }),
      },
      confidence: /\b\d{4}-\d{2}-\d{2}\b/.test(body) ? 0.88 : 0.7,
      extractionReason: "Matched deadline language.",
    };
  }

  private extractSummary(line: string, project: ProjectReference | undefined): ExtractedMemoryCandidate | undefined {
    const match = /^(?:summary|recap|status update)\s*[:\-]\s*(.+)$/i.exec(line.replace(/^[-*]\s*/, "").trim());
    const summary = match?.[1]?.trim();
    if (summary === undefined || summary.length < 8) {
      return undefined;
    }

    const cleaned = this.cleanStructuredText(summary);
    return {
      type: "Summary",
      ...(project === undefined ? {} : { project }),
      summary: {
        title: this.toTitle(cleaned),
        summary: cleaned,
        coveredRecordIds: [],
      },
      confidence: 0.84,
      extractionReason: "Matched explicit summary language.",
    };
  }

  private extractIsoDate(text: string): Date | undefined {
    const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
    return iso?.[1] === undefined ? undefined : new Date(`${iso[1]}T23:59:59.000Z`);
  }

  private cleanStructuredText(text: string): string {
    return text.replace(/\s+/g, " ").trim().replace(/[.!?]$/, "");
  }

  private toTitle(text: string): string {
    const cleaned = this.cleanStructuredText(text);
    return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 79).trim()}...`;
  }

  private dedupe(candidates: readonly ExtractedMemoryCandidate[]): readonly ExtractedMemoryCandidate[] {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = JSON.stringify(candidate);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
