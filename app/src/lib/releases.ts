import type { Project, ProjectRelease, ReleaseItem, StageCell, StageStatus } from "./server";

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
// Every stage cell assigned to this person that isn't done, across the project's releases, soonest release first.
export function myTodos(project: Pick<Project, "stages" | "releases">, userId: string, today = localDate()): Todo[] {
  const { upcoming, past } = orderReleases(project.releases, today);
  const todos: Todo[] = [];
  for (const release of [...upcoming, ...past]) for (const item of release.items) for (const stage of project.stages) {
    const cell = item.stages[stage];
    if (cell && cell.owner === userId && cell.status !== "done") todos.push({ release, item, stage, cell });
  }
  return todos;
}

// How far along a release is: cells done out of all its cells.
export function releaseProgress(release: ProjectRelease, stages: string[]) {
  const total = release.items.length * stages.length;
  const done = release.items.reduce((n, item) => n + stages.filter(s => item.stages[s]?.status === "done").length, 0);
  return { done, total };
}

// A short label for a phone chip: "Functional/508 QA" → "QA". Short names stay whole; otherwise an
// all-caps word in the name, else the first word. The full name is always in the accessibility label.
export function shortStage(stage: string) {
  if (stage.length <= 8) return stage;
  const words = stage.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.find(w => /^[A-Z0-9]{2,5}$/.test(w) && /[A-Z]/.test(w)) ?? (words[0] ?? stage).slice(0, 8);
}
