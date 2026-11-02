// Describes the authenticated session's client category, not hardware identity
// or attestation. Never expose arbitrary device labels supplied during pairing.
const labels = Object.freeze({ mobile: 'Mobile', computer: 'Computer', web: 'Browser' });
export function sourceDeviceKind(device) {
  const name = typeof device?.label === 'string' ? device.label.trim().toLowerCase() : '';
  if (['iphone', 'ipad', 'android phone', 'android tablet', 'phone', 'android', 'ios'].includes(name)) return 'mobile';
  if (['mac', 'macos', 'servant for mac', 'computer', 'windows', 'linux'].includes(name)) return 'computer';
  if (['browser', 'web'].includes(name)) return 'web';
  return null;
}

export function sourceDeviceFields(kind, viewer) {
  return viewer?.role === 'owner' && Object.hasOwn(labels, kind)
    ? { sourceDevice: { kind, label: labels[kind] } } : {};
}

// Private upstream/journal payloads are not a source of trusted device metadata.
// Only the immutable snapshot associated with the accepted local message ID is.
export function privateMessageView(message, viewer, snapshots) {
  if (!message || typeof message !== 'object') return message;
  const { sourceDevice: _ignored, ...result } = message;
  return { ...result, ...(message.role === 'user' ? sourceDeviceFields(snapshots.get(message.id), viewer) : {}) };
}
