// Describes the authenticated session's client category, not hardware identity
// or attestation. Never expose arbitrary device labels supplied during pairing.
const labels = Object.freeze({ mobile: 'Mobile', computer: 'Computer', web: 'Browser', agent: 'Posted by agent' });
export function sourceDeviceKind(device) {
  // A sign-in that belongs to an agent or other automation (the MCP link, "Hermes on Mac"): its posts are marked so
  // teammates can tell them from the person typing. The flag is set when the owner approves the link; a name that
  // says so also counts, so older links are covered.
  if (device?.agent === true) return 'agent';
  const name = typeof device?.label === 'string' ? device.label.trim().toLowerCase() : '';
  if (['iphone', 'ipad', 'android phone', 'android tablet', 'phone', 'android', 'ios'].includes(name)) return 'mobile';
  if (['mac', 'macos', 'servant for mac', 'computer', 'windows', 'linux'].includes(name)) return 'computer';
  if (['browser', 'web'].includes(name)) return 'web';
  if (['hermes', 'hermes on mac', 'mcp client', 'agent', 'automation'].includes(name)) return 'agent';
  return null;
}

export function sourceDeviceFields(kind, viewer) {
  // Mobile, computer and browser are for the owner only. "Posted by agent" is for everyone, because the people
  // reading need to know the message wasn't typed by the person whose name is on it.
  if (!Object.hasOwn(labels, kind)) return {};
  return kind === 'agent' || viewer?.role === 'owner' ? { sourceDevice: { kind, label: labels[kind] } } : {};
}

// Private upstream/journal payloads are not a source of trusted device metadata.
// Only the immutable snapshot associated with the accepted local message ID is.
// `posters` (optional) is { byMessage: Map(messageId -> userId), users, authorId }: a message posted by someone other than
// the chat's author (the owner joining a shared chat) carries `postedBy` so it is shown under the real poster.
export function privateMessageView(message, viewer, snapshots, posters) {
  if (!message || typeof message !== 'object') return message;
  const { sourceDevice: _ignored, postedBy: _poster, ...result } = message;
  const posterId = message.role === 'user' ? posters?.byMessage?.get(message.id) : undefined;
  const poster = posterId && posterId !== posters.authorId ? posters.users?.[posterId] : undefined;
  return { ...result, ...(message.role === 'user' ? sourceDeviceFields(snapshots.get(message.id), viewer) : {}),
    ...(poster ? { postedBy: { id: poster.id, name: poster.name } } : {}) };
}
