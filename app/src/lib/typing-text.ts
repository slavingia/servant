// The agent shows as "Agent" in every list of names.
export const AGENT_NAME = "Agent";
export function typingText(all: string[]): string {
  const agent = all.includes(AGENT_NAME);
  const names = all.filter((n) => n !== AGENT_NAME);
  if (agent) {
    if (names.length === 0) return `${AGENT_NAME} is replying…`;
    return `${typingText(names).replace(/…$/, "")} · ${AGENT_NAME} is replying…`;
  }
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

