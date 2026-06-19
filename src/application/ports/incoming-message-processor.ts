import type { IncomingMessage } from "../dto/incoming-message.js";

export interface IncomingMessageProcessorPort {
  execute(message: IncomingMessage): Promise<unknown>;
}
