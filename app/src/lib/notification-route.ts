export type NotificationRoute = { pathname: '/meeting/[id]'; params: { id: string } } | { pathname: '/c/[id]' | '/chat/[id]'; params: { id: string } } | { pathname: '/thread'; params: { conv: string; root: string; focus?: string; from?: 'push' } };
export function notificationRoute(data: Record<string, unknown>, userId: string, deviceId: string): NotificationRoute | null {
  if (data.userId !== userId || data.deviceId !== deviceId) return null;
  if (typeof data.meetingId === 'string' && /^meet_[A-Za-z0-9_-]{1,40}$/.test(data.meetingId)) return { pathname: '/meeting/[id]', params: { id: data.meetingId } };
  if (typeof data.conversationId === 'string' && /^(ch|dm)_[A-Za-z0-9_-]{1,80}$/.test(data.conversationId)) {
    if (typeof data.threadRoot === 'string' && /^\d{1,16}$/.test(data.threadRoot)) {
      // Land on the reply that was notified, not the top of the thread.
      const reply = typeof data.messageId === 'string' && /^\d{1,16}$/.test(data.messageId) && data.messageId !== data.threadRoot ? data.messageId : null;
      return { pathname: '/thread', params: { conv: data.conversationId, root: data.threadRoot, ...(reply ? { focus: reply, from: 'push' as const } : {}) } };
    }
    return { pathname: '/c/[id]', params: { id: data.conversationId } };
  }
  if (typeof data.chatId === 'string' && /^cht_[A-Za-z0-9_-]{1,80}$/.test(data.chatId)) return { pathname: '/chat/[id]', params: { id: data.chatId } };
  return null;
}
