import { designChatOptions, duplicateTitle, isVerifiedDesignChat } from "./designs";
import { api, ServerError, type Account, type Chat } from "./server";

/**
 * Duplicate: a new design of this person's that starts from another design's
 * current page, named "Copy of …". The new design is checked to be a design
 * workspace before anything is copied into it, and removed again if the copy fails.
 */
export async function duplicateDesign(account: Account, design: Pick<Chat, "id" | "title">, agentTier: number | null | undefined): Promise<Chat> {
  const chat = await api.newChat(account, designChatOptions(agentTier));
  if (!isVerifiedDesignChat(chat, agentTier)) {
    await api.deleteChat(account, chat.id).catch(() => {});
    throw new Error("This workspace didn't create a design. Ask a workspace owner to confirm your Design Studio access.");
  }
  try {
    await api.copyDesign(account, chat.id, design.id);
    return await api.renameChat(account, chat.id, duplicateTitle(design));
  } catch (e) {
    await api.deleteChat(account, chat.id).catch(() => {});
    throw e instanceof ServerError ? new Error(e.message) : e;
  }
}
