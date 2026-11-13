export function desktopMessageNotifies(input: {
  user: { id: string; name: string }; message: { text: string; user: { id: string }; pending?: boolean; deleted?: boolean; activity?: unknown };
  kind: 'channel' | 'dm'; preferences: { mode: 'all' | 'mentions' | 'none'; pausedUntil: number };
  archived: boolean; visible: boolean; participant?: boolean; now?: number;
}) {
  const { user, message, preferences } = input;
  if (input.archived || input.visible || message.user.id === user.id || message.pending || message.deleted || message.activity || preferences.mode === 'none' || preferences.pausedUntil > (input.now ?? Date.now())) return false;
  if (preferences.mode === 'all' || input.kind === 'dm' || input.participant) return true;
  const names = [user.id, user.name, user.name.replace(/\s+/g, '-'), user.name.split(/\s+/)[0], 'channel', 'here'].filter(Boolean);
  return names.some(name => new RegExp(`(^|[^\\w@])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\w-])`, 'i').test(message.text));
}
