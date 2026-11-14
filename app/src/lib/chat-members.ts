// Who else can read an agent chat, and how much of what came before they see. Teams asks the same when
// you add someone to a chat: none of it, the last day, the last week or all of it.
export type ChatHistory = "none" | "day" | "week" | "all";
export type ChatMember = { id: string; name: string; since: number; invitedAt: number };

export const HISTORY_CHOICES: { id: ChatHistory; label: string }[] = [
  { id: "none", label: "None" },
  { id: "day", label: "The last day" },
  { id: "week", label: "The last seven days" },
  { id: "all", label: "All of it" },
];

// What the person was given, from the times the server keeps.
export function historyLabel(member: Pick<ChatMember, "since" | "invitedAt">): string {
  if (!member.since) return "Sees the whole chat";
  const span = member.invitedAt - member.since;
  if (span <= 0) return "Sees from when they were added";
  if (span <= 86_400_000) return "Sees from the day before they were added";
  return "Sees from the week before they were added";
}

// "Jo Park", "Jo Park and Ana Ruiz", "Jo Park and two others" for the pill.
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
export function peopleSummary(names: string[]): string {
  if (!names.length) return "Just you";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 1;
  return `${names[0]} and ${words[rest] ?? rest} others`;
}
