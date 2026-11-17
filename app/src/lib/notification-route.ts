import { ALL_FEATURES, conversationHidden, type Features } from './features.ts';

export type NotificationRoute = { pathname: '/entitlements' } | { pathname: '/meeting/[id]'; params: { id: string } } | { pathname: '/c/[id]' | '/chat/[id]' | '/inbox/[id]'; params: { id: string } } | { pathname: '/thread'; params: { conv: string; root: string; focus?: string; from?: 'push' } };
// `features`: what this server uses (features.ts). A tap must never open a call on a server without
// meetings, or a channel or DM it has turned off, even from a notification sent before the change.
export function notificationRoute(data: Record<string, unknown>, userId: string, deviceId: string, features: Features = ALL_FEATURES): NotificationRoute | null {
  if (data.userId !== userId || data.deviceId !== deviceId) return null;
  if (features.meetings && typeof data.meetingId === 'string' && /^meet_[A-Za-z0-9_-]{1,40}$/.test(data.meetingId)) return { pathname: '/meeting/[id]', params: { id: data.meetingId } };
  if (typeof data.conversationId === 'string' && /^(ch|dm)_[A-Za-z0-9_-]{1,80}$/.test(data.conversationId)) {
    if (conversationHidden(data.conversationId, features)) return null;
    if (typeof data.threadRoot === 'string' && /^\d{1,16}$/.test(data.threadRoot)) {
      // Land on the reply that was notified, not the top of the thread.
      const reply = typeof data.messageId === 'string' && /^\d{1,16}$/.test(data.messageId) && data.messageId !== data.threadRoot ? data.messageId : null;
      return { pathname: '/thread', params: { conv: data.conversationId, root: data.threadRoot, ...(reply ? { focus: reply, from: 'push' as const } : {}) } };
    }
    return { pathname: '/c/[id]', params: { id: data.conversationId } };
  }
  // A visitor wrote to a case in the secure inbox. A server that turned Cases off opens nothing.
  if (typeof data.caseId === 'string' && /^inbox_[A-Za-z0-9_-]{1,80}$/.test(data.caseId)) return features.secureInbox ? { pathname: '/inbox/[id]', params: { id: data.caseId } } : null;
  // An entitlement request, decision or refused host (docs/entitlements.md) opens the Entitlements screen.
  if (data.page === 'entitlements') return { pathname: '/entitlements' };
  if (typeof data.chatId === 'string' && /^cht_[A-Za-z0-9_-]{1,80}$/.test(data.chatId)) return { pathname: '/chat/[id]', params: { id: data.chatId } };
  return null;
}
