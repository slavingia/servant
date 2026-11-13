import type { Project, ProjectRelease, ReleaseItem, Reviewer, StageCell, StageStatus } from "./server";

// Releases: the words, the order and the per-person view. Pure, so the screens stay small.
export const STATUSES: StageStatus[] = ["todo", "doing", "done", "blocked"];
export const STATUS_LABEL: Record<StageStatus, string> = { todo: "To do", doing: "Doing", done: "Done", blocked: "Blocked" };
export const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Today as YYYY-MM-DD in local time, the same form release dates use.
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// "Nov 17", with the year when it isn't this year. Release dates are plain days, read as local days.
export function releaseDate(date: string, now = new Date()) {
  const m = DATE_SHAPE.exec(date);
  if (!m) return "No date";
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!);
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}) });
}

// Upcoming releases first (soonest first, today counts), then past ones (most recent first).
export function orderReleases(releases: ProjectRelease[], today = localDate()) {
  const upcoming = releases.filter(r => r.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = releases.filter(r => r.date < today).sort((a, b) => b.date.localeCompare(a.date));
  return { upcoming, past };
}

export type Todo = { release: ProjectRelease; item: ReleaseItem; stage: string; cell: StageCell };
const EMPTY: StageCell = { status: "todo", owner: null, ownerName: "" };
// The people a stage's reviewers are, for every feature.
export const stageReviewers = (project: Pick<Project, "reviewers">, stage: string): Reviewer[] =>
  project.reviewers && Object.hasOwn(project.reviewers, stage) ? project.reviewers[stage] : [];
// Is this cell this person's? Its owner's, or with no owner, its stage's reviewers'.
export function ownsCell(project: Pick<Project, "reviewers">, cell: StageCell | undefined, stage: string, userId: string) {
  if (cell?.owner) return cell.owner === userId;
  return stageReviewers(project, stage).some(r => r.id === userId);
}
// Every stage cell that's this person's and isn't done, across the project's releases, soonest release first.
export function myTodos(project: Pick<Project, "stages" | "releases" | "reviewers">, userId: string, today = localDate()): Todo[] {
  const { upcoming, past } = orderReleases(project.releases, today);
  const todos: Todo[] = [];
  for (const release of [...upcoming, ...past]) for (const item of release.items) for (const stage of project.stages) {
    const cell = item.stages[stage] ?? (stageReviewers(project, stage).length ? EMPTY : undefined);
    if (cell && cell.status !== "done" && ownsCell(project, cell, stage, userId)) todos.push({ release, item, stage, cell });
  }
  return todos;
}
// "@jo-park @ana-ruiz" ⇄ ["jo-park", "ana-ruiz"], for the About tab's reviewer fields.
export const reviewerText = (list: Reviewer[]) => list.map(r => `@${r.github ?? r.key}`).join(" ");
export const parseReviewers = (text: string) => [...new Set(text.split(/[\s,]+/).map(s => s.replace(/^@/, "").trim()).filter(Boolean))];

// A feature is checked when every stage is done and every part is ticked; with neither, its own tick decides.
// The server sends done; this is the same rule for an older server that doesn't.
export function featureDone(item: ReleaseItem, stages: string[]) {
  if (item.done !== undefined) return item.done;
  const parts = item.parts ?? [];
  if (!stages.length && !parts.length) return false;
  return stages.every(s => item.stages[s]?.status === "done") && parts.every(p => p.done);
}

// How far along a release is: features checked out of all its features, and whether the final box is open.
export function releaseProgress(release: ProjectRelease, stages: string[]) {
  const total = release.items.length;
  const done = release.items.filter(i => featureDone(i, stages)).length;
  return { done, total, ready: release.ready ?? (total > 0 && done === total) };
}

// A short label for a phone chip: "Functional/508 QA" → "QA". Short names stay whole; otherwise an
// all-caps word in the name, else the first word. The full name is always in the accessibility label.
export function shortStage(stage: string) {
  if (stage.length <= 8) return stage;
  const words = stage.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.find(w => /^[A-Z0-9]{2,5}$/.test(w) && /[A-Z]/.test(w)) ?? (words[0] ?? stage).slice(0, 8);
}
