import { chatInputSchema, type ChatInput, type ChatSubmitResult, type ConversationDetail, type ConversationList } from "../shared/chat-contracts";
import type { DataRepository } from "../data/repository";
import { RunServiceError } from "./run-service";

export interface ChatService {
  list(ownerUserId: string): Promise<ConversationList>;
  get(ownerUserId: string, id: string): Promise<ConversationDetail>;
  submit(ownerUserId: string, id: string, input: ChatInput): Promise<ChatSubmitResult>;
}
export function postgresChatService(repository: DataRepository): ChatService {
  return {
    list: (owner) => repository.listConversations(owner),
    get: (owner, id) => repository.getConversation(owner, id),
    submit(owner, id, input) {
      const parsed = chatInputSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError("invalid_request", 400);
      return repository.submitChat(owner, id, parsed.data);
    },
  };
}
