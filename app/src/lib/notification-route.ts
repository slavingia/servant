export type NotificationRoute = { pathname: '/c/[id]' | '/chat/[id]'; params: { id: string } } | { pathname: '/thread'; params: { conv: string; root: string } };
export function notificationRoute(data: Record<string, unknown>, userId: string, deviceId: string): NotificationRoute | null {
  if (data.userId !== userId || data.deviceId !== deviceId) return null;
  if (typeof data.conversationId === 'string' && /^(ch|dm)_[A-Za-z0-9_-]{1,80}$/.test(data.conversationId)) {
    if (typeof data.threadRoot === 'string' && /^\d{1,16}$/.test(data.threadRoot)) return { pathname: '/thread', params: { conv: data.conversationId, root: data.threadRoot } };
    return { pathname: '/c/[id]', params: { id: data.conversationId } };
  }
  if (typeof data.chatId === 'string' && /^cht_[A-Za-z0-9_-]{1,80}$/.test(data.chatId)) return { pathname: '/chat/[id]', params: { id: data.chatId } };
  return null;
}
