// To-dos as a file Jira's CSV importer reads ("External System Import", CSV). Servant is where the work is done;
// this is how it is copied into Jira in one batch. Nothing here talks to Jira: it only writes text.
//
// One row per to-do. A to-do that already has a Jira key carries it in "Issue Key", so the importer updates that
// issue; one without is created. "Issue Id" and "Parent Id" are the to-do's own number and its epic's, which is how
// the importer links a to-do to its epic. Every row has the label servant-<number>, so the issue a to-do became can
// be found in Jira afterwards and its key recorded here.
export const JIRA_DATE_FORMAT = "yyyy-MM-dd HH:mm";
const TYPE = { task: "Task", bug: "Bug", story: "Story", epic: "Epic" };
const STATUS = { todo: "To Do", doing: "In Progress", done: "Done" };
const PRIORITY = { high: "High", medium: "Medium", low: "Low" };
const FIELDS = ["Issue Key", "Issue Id", "Parent Id", "Summary", "Issue Type", "Status", "Priority", "Description", "Assignee", "Reporter",
  "Due Date", "Created", "Resolved", "Story Points", "Fix Version", "Labels"];

/** A time as Jira is told to read it (JIRA_DATE_FORMAT), in UTC. */
export function jiraTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
/** One CSV cell: quoted when it holds a comma, a quote or a line break. */
export function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export const jiraLabel = number => `servant-${number}`;

/**
 * The CSV for these to-dos. Each is what the to-do store's export gives: the to-do as its reader sees it, plus
 * parentNumber and comments. Comments become as many "Comment" columns as the most-discussed to-do needs.
 */
export function jiraCsv(issues) {
  const most = issues.reduce((max, issue) => Math.max(max, issue.comments?.length ?? 0), 0);
  const header = [...FIELDS, ...Array.from({ length: most }, () => "Comment")];
  const rows = issues.map(issue => {
    const cells = [
      issue.jiraKey || "", issue.number, issue.parentNumber ?? "", issue.text, TYPE[issue.type] || TYPE.task, STATUS[issue.stage] || STATUS.todo,
      PRIORITY[issue.priority] || "", issue.description || "", issue.assignee?.name || "", issue.createdByName || "",
      issue.due || "", jiraTime(issue.createdAt), issue.doneAt ? jiraTime(issue.doneAt) : "", issue.estimate ?? "", issue.releaseName || "",
      jiraLabel(issue.number),
    ];
    // Jira reads a comment cell as "date; author; text".
    const comments = (issue.comments ?? []).map(comment => `${jiraTime(comment.createdAt)}; ${comment.author?.name || "Someone"}; ${comment.text}`);
    return [...cells, ...comments, ...Array.from({ length: most - comments.length }, () => "")];
  });
  return [header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
