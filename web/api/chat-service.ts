import { z } from "zod";
import { chatInputSchema, chatSubmitResultSchema, conversationDetailSchema, conversationIdSchema, conversationListSchema, type ChatInput, type ChatSubmitResult, type ConversationDetail, type ConversationList } from "../shared/chat-contracts";
import { bridgeRequest, invokeBridge, RunServiceError, type BridgeInvoke } from "./run-service";

export interface ChatService {
  list(ownerUserId: string): Promise<ConversationList>;
  get(ownerUserId: string, id: string): Promise<ConversationDetail>;
  submit(ownerUserId: string, id: string, input: ChatInput): Promise<ChatSubmitResult>;
}

export function pythonChatService(invoke: BridgeInvoke = invokeBridge): ChatService {
  function validId(id: string) {
    const parsed = conversationIdSchema.safeParse(id);
    if (!parsed.success) throw new RunServiceError("invalid_conversation_id", 400);
    return parsed.data;
  }
  function scoped(ownerUserId: string, input: unknown) {
    const owner = z.uuid().safeParse(ownerUserId);
    if (!owner.success) throw new RunServiceError("invalid_owner_user_id", 400);
    return { owner_user_id: owner.data.toLowerCase(), input };
  }
  return {
    list: (ownerUserId) => bridgeRequest("conversations", scoped(ownerUserId, {}), conversationListSchema, invoke),
    async get(ownerUserId, id) {
      id = validId(id);
      const detail = await bridgeRequest("conversation", scoped(ownerUserId, { id }), conversationDetailSchema, invoke);
      if (detail.conversation.id !== id) throw new RunServiceError("invalid_bridge_response");
      return detail;
    },
    async submit(ownerUserId, id, input) {
      id = validId(id);
      const parsed = chatInputSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError("invalid_request", 400);
      const result = await bridgeRequest("chat", scoped(ownerUserId, { id, ...parsed.data }), chatSubmitResultSchema, invoke);
      if (result.conversation_id !== id) throw new RunServiceError("invalid_bridge_response");
      return result;
    },
  };
}
