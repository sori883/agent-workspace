import { chatInputSchema, type ChatInput, type ChatSubmitResult, type ConversationDetail, type ConversationList } from "../shared/chat-contracts";
import type { DataRepository } from "../data/repository";
import { RunServiceError } from "./run-service";

export interface ChatService {
  list(ownerUserId: string, workspace?: string | null): Promise<ConversationList>;
  get(ownerUserId: string, id: string, workspace?: string | null): Promise<ConversationDetail>;
  submit(ownerUserId: string, id: string, input: ChatInput, workspace?: string | null): Promise<ChatSubmitResult>;
}
export function postgresChatService(repository: DataRepository): ChatService {
  return {
    list: (owner, workspace) => repository.listConversations(owner, workspace),
    get: (owner, id, workspace) => repository.getConversation(owner, id, workspace),
    submit(owner, id, input, workspace) {
      const parsed = chatInputSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError("invalid_request", 400);
      return repository.submitChat(owner, id, parsed.data, workspace);
    },
  };
}
