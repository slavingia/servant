// Deep work (docs/features.md "Deep work"): a person's own quiet mode. While it is on, their apps hide channels,
// direct messages and land on the agent, everyone else sees "Deep work" as their status,
// and nothing buzzes for them: no push for a channel message, a mention or a direct message.
// Their own agent's pushes still come through. Nothing is deleted or muted on the server:
// messages still arrive and count as unread.
//
// It lives on the person, not the device (state.users[id].deepWorkSince, in ms), so every device of
// theirs agrees. Absent means off, which is what everyone from before the switch existed has. An
// instance's own feature flags (features.mjs) stay the operator's override: deep work only hides.
export const inDeepWork = user => Number.isFinite(user?.deepWorkSince) && user.deepWorkSince > 0;

/** Flip the switch on a user record. Turning it on again never moves the start time. */
export function setDeepWork(user, on, at = Date.now()) {
  if (on) { if (!inDeepWork(user)) user.deepWorkSince = at; }
  else delete user.deepWorkSince;
}

/** `{ deepWork: true }` for people and presence views; nothing at all while off, so old builds see what they always did. */
export const deepWorkFields = user => inDeepWork(user) ? { deepWork: true } : {};
