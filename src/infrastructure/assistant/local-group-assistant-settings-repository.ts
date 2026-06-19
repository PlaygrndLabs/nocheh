import type { GroupAssistantSettingsRepositoryPort } from "../../application/ports/group-assistant-settings-repository.js";
import type {
  GroupAssistantSettings,
  AssistantReplyMode,
  MessageAnalysisMode,
} from "../../domain/assistant/group-assistant-settings.js";
import type { EncryptedJsonFileStore } from "../memory/encrypted-json-file-store.js";

interface StoredGroupAssistantSettings extends Omit<GroupAssistantSettings, "updatedAt"> {
  readonly analysisMode: MessageAnalysisMode;
  readonly replyMode: AssistantReplyMode;
  readonly updatedAt: string;
}

/** Local encrypted settings repository keyed by Telegram conversation id. */
export class LocalGroupAssistantSettingsRepository implements GroupAssistantSettingsRepositoryPort {
  public constructor(private readonly store: EncryptedJsonFileStore<readonly StoredGroupAssistantSettings[]>) {}

  public async save(settings: GroupAssistantSettings): Promise<void> {
    const records = await this.store.read();
    const next = records.filter((record) => record.conversationId !== settings.conversationId);
    await this.store.write([...next, this.serialize(settings)]);
  }

  public async findByConversationId(conversationId: string): Promise<GroupAssistantSettings | undefined> {
    const record = (await this.store.read()).find((candidate) => candidate.conversationId === conversationId);
    return this.deserializeOptional(record);
  }

  private serialize(settings: GroupAssistantSettings): StoredGroupAssistantSettings {
    return {
      ...settings,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  private deserializeOptional(record: StoredGroupAssistantSettings | undefined): GroupAssistantSettings | undefined {
    return record === undefined ? undefined : this.deserialize(record);
  }

  private deserialize(record: StoredGroupAssistantSettings): GroupAssistantSettings {
    return {
      ...record,
      updatedAt: new Date(record.updatedAt),
    };
  }
}
