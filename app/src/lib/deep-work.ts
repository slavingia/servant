// Deep work (server/deep-work.mjs, docs/features.md "Deep work"): your own quiet mode, kept on the server against
// you, so every device you use agrees. While it is on, the app hides channels, direct messages,
// the secure inbox and People (features.ts withDeepWork) and lands on the agent; everyone else sees "Deep work" as your
// status; messages still arrive and count as unread, but nothing buzzes. It ends only when you switch it off.

/** The server's word on the switch: on only when it says exactly `true`. An older server says nothing, meaning off. */
export const deepWorkFromServer = (raw: unknown): boolean => raw === true;

export const DEEP_WORK_HINT = "Hides channels, direct messages, the secure inbox and People. Messages still arrive, nothing buzzes, and others see you're in deep work. Your agent and projects stay.";
