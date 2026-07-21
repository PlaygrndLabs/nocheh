import type { NoteProcessorPort } from "../../../application/ports/incoming-message-processor.js";
import type { JsonHandler } from "../router.js";

export interface NoteRoutes {
  readonly submit: JsonHandler;
}

/** Route for Mak's manual notes: authoritative knowledge updates sent outside group chatter. */
export function createNoteRoutes(noteProcessor: NoteProcessorPort): NoteRoutes {
  return {
    submit: async ({ body }) => {
      const input = body as { conversationId?: unknown; text?: unknown; authorDisplayName?: unknown } | undefined;
      if (typeof input?.text !== "string" || input.text.trim().length === 0) {
        return { status: 400, body: { ok: false, error: "Expected a non-empty { text }" } };
      }
      const result = await noteProcessor.executeNote({
        conversationId: typeof input.conversationId === "string" && input.conversationId.length > 0 ? input.conversationId : "notes",
        text: input.text,
        ...(typeof input.authorDisplayName === "string" ? { authorDisplayName: input.authorDisplayName } : {}),
      });
      return { status: 200, body: { ok: true, result } };
    },
  };
}
