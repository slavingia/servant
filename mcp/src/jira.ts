// The one-command copy of Servant's to-dos into Jira, run where Jira is reachable (a work laptop).
//
//   servant-mcp jira-export [file.csv] [project id]   write the file Jira's CSV importer reads
//   servant-mcp jira-keys <jira export.csv>           record which Jira issue each to-do became
//
// Servant is where the work is done. Nothing here signs in to Jira or sends it anything: the first command writes
// a file you import in Jira, the second reads a file you exported from Jira.
import fs from "node:fs";
import { call, type Account } from "./client.ts";

type Exported = { csv: string; count: number; dateFormat: string; issues: { id: string; number: number; key: string; jiraKey: string | null; canEdit: boolean }[] };

/** Rows of a CSV file: quoted cells may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(value => value !== ""));
}

/**
 * From a CSV exported from Jira: the Jira key of each issue that carries a servant-<number> label. Jira writes one
 * "Labels" column per label, so every column of that name is read.
 */
export function jiraKeysByNumber(text: string): Map<number, string> {
  const [header, ...rows] = parseCsv(text);
  const found = new Map<number, string>();
  if (!header) return found;
  const names = header.map(name => name.trim().toLowerCase());
  const keyAt = names.indexOf("issue key");
  const labelAt = names.flatMap((name, index) => name === "labels" || name === "label" ? [index] : []);
  if (keyAt < 0 || !labelAt.length) throw new Error('That file needs an "Issue key" column and a "Labels" column. Export issues from Jira as CSV with all fields.');
  for (const row of rows) {
    const key = (row[keyAt] ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,8}$/.test(key)) continue;
    for (const label of labelAt.flatMap(index => (row[index] ?? "").split(/[\s,]+/))) {
      const match = /^servant-([1-9][0-9]{0,9})$/i.exec(label.trim());
      if (match) found.set(Number(match[1]), key);
    }
  }
  return found;
}

export async function jiraExport(account: Account, file?: string, project?: string, log: (line: string) => void = console.error): Promise<string> {
  if (project && !/^[A-Za-z0-9_-]{1,80}$/.test(project)) throw new Error("That is not a project id");
  const out = await call<Exported>(account, "GET", `/v1/todos/export${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  const target = file || `servant-jira-${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(target, out.csv, { mode: 0o600 });
  const known = out.issues.filter(issue => issue.jiraKey).length;
  log(`Wrote ${out.count} to-dos to ${target}: ${known} update an existing Jira issue, ${out.count - known} are new.`);
  log(`In Jira: import the file as CSV, with the date format ${out.dateFormat}. Then export those issues from Jira as CSV and run: servant-mcp jira-keys <that file>`);
  return target;
}

export async function jiraKeys(account: Account, file: string, log: (line: string) => void = console.error): Promise<{ saved: number; skipped: number }> {
  const keys = jiraKeysByNumber(fs.readFileSync(file, "utf8"));
  const { issues } = await call<Exported>(account, "GET", "/v1/todos/export");
  let saved = 0, skipped = 0;
  for (const issue of issues) {
    const key = keys.get(issue.number);
    if (!key || key === issue.jiraKey) continue;
    if (!issue.canEdit) { skipped++; continue; }
    await call(account, "PATCH", `/v1/todos/${encodeURIComponent(issue.id)}`, { jiraKey: key });
    saved++;
  }
  log(`Recorded ${saved} Jira ${saved === 1 ? "key" : "keys"}${skipped ? `; ${skipped} to-dos are not yours to change` : ""}. The next export updates those issues instead of making new ones.`);
  return { saved, skipped };
}
