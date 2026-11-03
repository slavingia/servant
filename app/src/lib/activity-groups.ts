import type { Post } from "./server";

// Joins and leaves that happen close together read as one line:
// "Ann Lee and Bo Park joined the channel", "Ann Lee, Bo Park and 3 others
// joined the channel", "Ann Lee joined, and Bo Park left the channel".

const WINDOW = 30 * 60 * 1000;

type Place = "channel" | "servant";
const placeOf = (post: Post): Place => / left Servant$/.test(post.text) ? "servant" : "channel";

export function nameList(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** One sentence for a run of activity posts, oldest first. */
export function activitySentence(run: readonly Post[]): string {
  const place = placeOf(run[0]!);
  // What each person did over the run, in the order they first appear.
  const people = new Map<string, { name: string; first: "joined" | "left"; last: "joined" | "left" }>();
  for (const post of run) {
    const action = post.activity === "left" ? "left" : "joined";
    const seen = people.get(post.user.id);
    if (seen) seen.last = action;
    else people.set(post.user.id, { name: post.user.name, first: action, last: action });
  }
  const clauses = new Map<string, string[]>();
  for (const { name, first, last } of people.values()) {
    const verb = first === last ? first : first === "joined" ? "joined and left" : "rejoined";
    clauses.set(verb, [...(clauses.get(verb) ?? []), name]);
  }
  const parts = [...clauses].map(([verb, names]) => `${nameList(names)} ${verb}`);
  const body = parts.length <= 1 ? parts[0] ?? "" : parts.length === 2 ? `${parts[0]}, and ${parts[1]}` : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  return `${body} ${place === "servant" ? "Servant" : "the channel"}`;
}

/**
 * Collapse runs of activity in a newest-first list (as rendered by the
 * inverted message list). A run stays on one day, within 30 minutes between
 * neighbours, and doesn't mix channel joins/leaves with leaving Servant.
 */
export function groupActivity(newestFirst: readonly Post[]): Post[] {
  const out: Post[] = [];
  let run: Post[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) out.push(run[0]!);
    else {
      const oldestFirst = [...run].reverse();
      const newest = run[0]!;
      // Keyed by the oldest post so the row stays put as more people join.
      out.push({ ...newest, id: oldestFirst[0]!.id, text: activitySentence(oldestFirst) });
    }
    run = [];
  };
  for (const post of newestFirst) {
    const previous = run.at(-1);
    const fits = post.activity && previous
      && placeOf(post) === placeOf(previous)
      && previous.createdAt - post.createdAt <= WINDOW
      && new Date(previous.createdAt).toDateString() === new Date(post.createdAt).toDateString();
    if (!fits) flush();
    if (post.activity) run.push(post);
    else out.push(post);
  }
  flush();
  return out;
}
