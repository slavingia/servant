// Personal connections (docs/connections.md): the words and rules of the form a person fills in to give their agent
// their own credentials for a tool, and of the Connections screen. The server decides; this says what to show.
// A value typed here goes to the server once and is never read back: the app only ever learns its last four characters.

export type ConnectField = { key: string; label: string; placeholder: string; pattern?: string; secret: boolean };
/** A tool type, as data from the server: GitHub, Jira, or one an owner defined. */
export type ConnectTool = { id: string; name: string; heading: string; help: string; createUrl: string; hosts: string[]; fields: ConnectField[] };
/** Where a person stands on a tool: nothing when not connected. Never the value. */
export type ConnectionStanding = { type: string; last4: string; account?: string; savedAt: number; usedAt?: number };
/** "full": the agent runs commands and can use a connection. "restricted" and "none": it can't, so there is nothing to save. */
export type ConnectionAgent = "full" | "restricted" | "none";
export type ConnectionsPage = { tools: (ConnectTool & { mine: ConnectionStanding | null })[]; agent: ConnectionAgent };
/** The form the agent asked for, as a part of its message. `mine` is false for someone else reading the chat. */
export type ConnectPart = { requestId: string; mine: boolean; status: "open" | "saved" | "declined" | "removed"; last4?: string; account?: string; agent?: ConnectionAgent; tool: ConnectTool };

export const KEPT_OUT_LINE = "Kept out of chat. Only your agent's commands can use it.";
export const RESTRICTED_LINE = "Your agent can't run commands, so it can't use this yet. Ask an owner to give you the full agent first.";
export const NO_AGENT_LINE = "You don't have an agent yet, so nothing could use this. Ask an owner to give you the full agent first.";

const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";

/** A tool type from the server, or null when it is not one this app can show a form for. */
export function parseTool(raw: unknown): ConnectTool | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id || typeof t.name !== "string" || !t.name || !Array.isArray(t.fields)) return null;
  const fields: ConnectField[] = [];
  for (const f of t.fields as Record<string, unknown>[]) {
    if (!f || typeof f.key !== "string" || !f.key) return null;
    fields.push({ key: f.key, label: text(f.label, 60) || f.key, placeholder: text(f.placeholder, 80), ...(typeof f.pattern === "string" && f.pattern ? { pattern: f.pattern } : {}), secret: f.secret !== false });
  }
  if (!fields.length) return null;
  return { id: t.id, name: text(t.name, 40), heading: text(t.heading, 80) || `${text(t.name, 40)} token for your account`, help: text(t.help, 300),
    createUrl: typeof t.createUrl === "string" && /^https:\/\//.test(t.createUrl) ? t.createUrl : "", hosts: Array.isArray(t.hosts) ? t.hosts.filter((h): h is string => typeof h === "string") : [], fields };
}

/** The "connect" parts of a message from the server; anything that isn't one is left out. */
export function parseConnectParts(raw: unknown): ConnectPart[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ConnectPart[] => {
    const p = item as Record<string, unknown> | null;
    const tool = parseTool(p?.tool);
    if (!p || !tool || typeof p.requestId !== "string" || !["open", "saved", "declined", "removed"].includes(p.status as string)) return [];
    return [{ requestId: p.requestId, mine: p.mine === true, status: p.status as ConnectPart["status"], tool,
      ...(typeof p.last4 === "string" ? { last4: p.last4.slice(-4) } : {}), ...(typeof p.account === "string" ? { account: p.account.slice(0, 100) } : {}),
      ...(p.agent === "full" || p.agent === "restricted" || p.agent === "none" ? { agent: p.agent } : {}) }];
  });
}

/** Whether what is typed fits a field. A pattern this phone can't read is left to the server. */
export function fieldValid(field: ConnectField, value: string): boolean {
  const typed = value.trim();
  if (!typed || typed.length > 2000 || /[\u0000-\u001f\u007f]/.test(typed)) return false;
  if (!field.pattern) return true;
  try { return new RegExp(field.pattern).test(typed); } catch { return true; }
}

/** Save is on only when every field fits. */
export const formValid = (tool: ConnectTool, values: Record<string, string>) => tool.fields.every(field => fieldValid(field, values[field.key] ?? ""));

/** What to say under a field once something is typed that doesn't fit; nothing while it is empty or right. */
export function fieldProblem(field: ConnectField, value: string): string | null {
  if (!value.trim() || fieldValid(field, value)) return null;
  return field.placeholder ? `That doesn't look like ${field.label.toLowerCase()}. It should look like ${field.placeholder}` : `That doesn't look like ${field.label.toLowerCase()}`;
}

/** What is sent: each field trimmed, and nothing else. */
export const formValues = (tool: ConnectTool, values: Record<string, string>) => Object.fromEntries(tool.fields.map(field => [field.key, (values[field.key] ?? "").trim()]));

/** The site a tool's token is made on, for the button: "github.com". */
export function createHost(tool: ConnectTool): string {
  try { return new URL(tool.createUrl).hostname.replace(/^www\./, ""); } catch { return ""; }
}
export const openLabel = (tool: ConnectTool) => `Open ${createHost(tool)}`;

const dots = (last4?: string) => last4 ? `••••${last4}` : "";
/** The collapsed card after saving: "GitHub token saved · ••••a1b2". Never the value. */
export const savedLine = (tool: ConnectTool, last4?: string) => [`${tool.name} token saved`, dots(last4)].filter(Boolean).join(" · ");

/** What the card is, from what the server said and what happened on this phone since. */
export type CardState = "form" | "saved" | "declined" | "removed" | "asked" | "restricted";
export function cardState(part: Pick<ConnectPart, "mine" | "status" | "agent">, local?: "saved" | "declined" | null): CardState {
  if (!part.mine) return "asked";
  if (local) return local;
  if (part.status !== "open") return part.status;
  return part.agent && part.agent !== "full" ? "restricted" : "form";
}
/** One quiet line for a card that is not a form. */
export function cardLine(state: Exclude<CardState, "form" | "restricted">, tool: ConnectTool, last4?: string, status?: ConnectPart["status"]): string {
  switch (state) {
    case "saved": return savedLine(tool, last4);
    case "declined": return "Declined";
    case "removed": return `${tool.name} token removed`;
    // Someone else's chat: that it was asked and how it ended, nothing more.
    case "asked": return status === "saved" ? `${tool.name} token saved` : status === "declined" ? `Declined to connect ${tool.name}` : `The agent asked for a ${tool.name} token`;
  }
}

/** Connections: where you stand on a tool. */
export function standingLine(mine: ConnectionStanding | null): string {
  if (!mine) return "Not connected";
  return [mine.account ? `Connected as ${mine.account}` : "Connected", dots(mine.last4)].filter(Boolean).join(" ");
}
const day = (at: number, now: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
/** Connections: when it was saved and last used. */
export function timesLine(mine: ConnectionStanding | null, now: number): string {
  if (!mine) return "";
  return `Saved ${day(mine.savedAt, now)} · ${mine.usedAt ? `Last used ${day(mine.usedAt, now)}` : "Not used yet"}`;
}
