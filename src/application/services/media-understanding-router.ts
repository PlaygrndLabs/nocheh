import type { MessageAttachment } from "../../domain/messaging/message-attachment.js";
import type {
  MediaUnderstandingInput,
  MediaUnderstandingPort,
  MediaUnderstandingResult,
} from "../ports/media-understanding.js";

/**
 * Dispatches each attachment kind to the model configured for that kind.
 *
 * Image and audio are separate roles, so they can point at different models or at
 * the same omni model. Nothing here knows which provider is behind a kind.
 */
export class MediaUnderstandingRouter implements MediaUnderstandingPort {
  public constructor(
    private readonly byKind: Readonly<Partial<Record<MessageAttachment["kind"], MediaUnderstandingPort>>>,
  ) {}

  public supports(kind: MessageAttachment["kind"]): boolean {
    const delegate = this.byKind[kind];
    return delegate !== undefined && delegate.supports(kind);
  }

  public async understand(input: MediaUnderstandingInput): Promise<MediaUnderstandingResult> {
    const delegate = this.byKind[input.attachment.kind];
    if (delegate === undefined) {
      throw new Error(`No model is configured for ${input.attachment.kind} attachments.`);
    }
    return delegate.understand(input);
  }

  /** True when at least one kind has a model, so the pipeline can skip the step entirely. */
  public get hasAnyModel(): boolean {
    return Object.keys(this.byKind).length > 0;
  }
}
