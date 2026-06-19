import type { GroupAssistantSettings } from "../../domain/assistant/group-assistant-settings.js";

export interface GroupAssistantSettingsRepositoryPort {
  save(settings: GroupAssistantSettings): Promise<void>;
  findByConversationId(conversationId: string): Promise<GroupAssistantSettings | undefined>;
}
