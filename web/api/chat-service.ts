import { chatInputSchema, chatSubmitResultSchema, conversationDetailSchema, conversationIdSchema, conversationListSchema, type ChatInput, type ChatSubmitResult, type ConversationDetail, type ConversationList } from "../shared/chat-contracts";
import { bridgeRequest, invokeBridge, RunServiceError, type BridgeInvoke } from "./run-service";

export interface ChatService {
  list(): Promise<ConversationList>;
  get(id: string): Promise<ConversationDetail>;
  submit(id: string, input: ChatInput): Promise<ChatSubmitResult>;
}

export function pythonChatService(invoke: BridgeInvoke = invokeBridge): ChatService {
  function validId(id: string) {
    const parsed = conversationIdSchema.safeParse(id);
    if (!parsed.success) throw new RunServiceError("invalid_conversation_id", 400);
    return parsed.data;
  }
  return {
    list: () => bridgeRequest("conversations", {}, conversationListSchema, invoke),
    async get(id) {
      id = validId(id);
      const detail = await bridgeRequest("conversation", { id }, conversationDetailSchema, invoke);
      if (detail.conversation.id !== id) throw new RunServiceError("invalid_bridge_response");
      return detail;
    },
    async submit(id, input) {
      id = validId(id);
      const parsed = chatInputSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError("invalid_request", 400);
      const result = await bridgeRequest("chat", { id, ...parsed.data }, chatSubmitResultSchema, invoke);
      if (result.conversation_id !== id) throw new RunServiceError("invalid_bridge_response");
      return result;
    },
  };
}
