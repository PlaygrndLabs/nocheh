import type { ExtractedTaskCandidate } from "../../domain/tasks/task-extraction.js";
import type { IncomingMessage } from "../dto/incoming-message.js";

/** Extracts candidate tasks from sanitized platform-neutral messages. */
export interface TaskExtractorPort {
  extractTasks(message: IncomingMessage): Promise<readonly ExtractedTaskCandidate[]>;
}
