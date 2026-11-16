#!/usr/bin/env node
// Hand work to people through Servant from a script or an agent: read and post in conversations,
// keep a project's release checklist true, and see what came back after an ask.
// It signs in as the linked device (docs/mcp.md), so everything it posts shows as that person,
// labelled "Posted by agent". When and how to use it: skills/review-handoff/SKILL.md.
//
//   node mcp/src/handoff.ts <command> ...      (`node mcp/src/handoff.ts help` lists them)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accountFile, call, loadAccount } from "./client.ts";

export type Ask = { conv: string; feature: string; who: string; context: string; seen: string | null; at: string };
export type Msg = { id: string; text?: string; deleted?: boolean; createdAt?: number; user?: { id: string; name: string }; attachments?: unknown[] };

/** The messages other people sent after the last one an ask has seen. An unknown marker means everything is new. */
export function freshReplies(messages: Msg[], seen: string | null, myId: string): Msg[] {
  const i = seen === null ? -1 : messages.findIndex(m => m.id === seen);
  return messages.slice(i + 1).filter(m => m.user?.id !== myId && !m.deleted);
}

/** One ask per conversation and feature: logging it again moves the marker and keeps its context. */
export function logAsk(list: Ask[], ask: Omit<Ask, "context"> & { context?: string }): Ask[] {
  const prior = list.find(x => x.conv === ask.conv && x.feature === ask.feature);
  return [...list.filter(x => x !== prior), { ...ask, context: ask.context || prior?.context || "" }];
}

/** Exactly one item whose id, date or name matches; otherwise an error that lists the choices. */
export function pickOne<T extends { id: string; name?: string; title?: string; date?: string }>(list: T[], key: string, what: string): T {
  const k = key.toLowerCase();
  const hit = list.filter(x => x.id === key || x.date === key || (x.name ?? x.title ?? "").toLowerCase().includes(k));
  if (hit.length !== 1) throw new Error(`${what} "${key}" matched ${hit.length}: ${list.map(x => x.name ?? x.title).join(", ")}`);
  return hit[0]!;
}

/** `post` arguments: text, an optional thread root, and the files after --attach. */
export function postArgs(args: string[]): { conv: string; text: string; threadRoot?: string; files: string[] } {
  const at = args.indexOf("--attach");
  const rest = at >= 0 ? args.slice(0, at) : args;
  const [conv, text, threadRoot] = rest;
  if (!conv || !text) throw new Error("post needs a conversation id and the text");
  return { conv, text, ...(threadRoot ? { threadRoot } : {}), files: at >= 0 ? args.slice(at + 1) : [] };
}

const HELP = `commands:
  whoami                                   who this device posts as, and the server
  people                                   everyone on the server, with ids
  convs                                    your channels and DMs, with ids
  read <conversation> [count]              recent messages (default 20)
  dm <user_id>...                          one id opens a DM, several a group chat; prints the conversation id
  channel <name> [topic] [private]         make a channel
  post <conversation> <text> [thread_root] [--attach <file>...]
  releases <project>                       stages, reviewers, releases, items and each cell's status
  cell <project> <release> <item> <stage> <todo|doing|done|blocked> [note]
  add-release <project> <name> <YYYY-MM-DD>
  add-item <project> <release> <title>
  ship <project> <release>                 tick Shipped (every item must be done)
  ask-log <conversation> <feature> <who> [context]   record that an ask is waiting for a reply
  replies [--mark]                         what other people sent since each logged ask; --mark records them as seen`;

const asksFile = () => path.join(path.dirname(accountFile()), "handoffs.json");
const readAsks = (): Ask[] => { try { return JSON.parse(fs.readFileSync(asksFile(), "utf8")); } catch { return []; } };
const writeAsks = (list: Ask[]) => fs.writeFileSync(asksFile(), JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
const oneLine = (text = "") => text.replace(/\n/g, " ⏎ ");

async function main(cmd: string | undefined, args: string[]) {
  if (!cmd || cmd === "help") return console.log(HELP);
  const account = loadAccount();
  if (!account) throw new Error("Not signed in. Link this computer first: node mcp/src/index.ts link \"<workspace link>\" (docs/mcp.md)");
  const api = (method: string, apiPath: string, body?: unknown): Promise<any> => call(account, method, apiPath, body);
  const enc = encodeURIComponent;
  const need = (i: number, what: string) => { if (!args[i]) throw new Error(`${cmd} needs ${what}`); return args[i]!; };
  const project = async (id: string) => (await api("GET", `/v1/projects/${enc(id)}`)).project;
  const messages = async (conv: string): Promise<Msg[]> => (await api("GET", `/v1/conversations/${enc(conv)}/messages`)).messages ?? [];

  switch (cmd) {
    case "whoami": return console.log(`${account.user.name} | ${account.user.role} | ${account.server}`);
    case "people": for (const p of (await api("GET", "/v1/people")).people) console.log(`${p.id} | ${p.name}`); return;
    case "convs": for (const c of (await api("GET", "/v1/conversations")).conversations) console.log(`${c.id} | ${c.kind ?? "channel"} | ${c.name ?? c.title ?? ""}`); return;
    case "read": {
      for (const m of (await messages(need(0, "a conversation id"))).slice(-(Number(args[1]) || 20)))
        console.log(`${new Date(m.createdAt ?? 0).toISOString().slice(0, 16)} | ${m.user?.name ?? "?"} | ${m.id} | ${oneLine(m.text)}${m.attachments?.length ? ` [${m.attachments.length} attachment(s)]` : ""}`);
      return;
    }
    case "dm": need(0, "at least one user id"); return console.log((await api("POST", "/v1/conversations", { kind: "dm", userIds: args })).conversation.id);
    case "channel": return console.log((await api("POST", "/v1/conversations", { name: need(0, "a name"), topic: args[1], private: args[2] === "private" })).conversation.id);
    case "post": {
      const { conv, text, threadRoot, files } = postArgs(args);
      const attachments = files.map(file => ({ name: path.basename(file), data: fs.readFileSync(file).toString("base64") }));
      const d = await api("POST", `/v1/conversations/${enc(conv)}/messages`, { text, ...(threadRoot ? { threadRoot } : {}), ...(attachments.length ? { attachments } : {}) });
      return console.log(`posted ${d.message?.id ?? "?"}`);
    }
    case "releases": {
      const p = await project(need(0, "a project id"));
      console.log(`stages: ${p.stages.join(", ")}`);
      console.log(`reviewers: ${Object.entries(p.reviewers ?? {}).map(([stage, who]: any) => `${stage}: ${who.map((x: any) => `${x.name} (${x.id})`).join(", ")}`).join(" | ")}`);
      for (const r of p.releases) {
        console.log(`\n${r.name} (${r.date}) ${r.id}${r.shipped ? " SHIPPED" : ""}`);
        for (const i of r.items) console.log(`  ${i.title} ${i.id}: ${p.stages.map((s: string) => `${s}=${i.stages?.[s]?.status ?? "todo"}`).join(", ")}`);
      }
      return;
    }
    case "cell": {
      const pid = need(0, "a project id"); const p = await project(pid);
      const r = pickOne<any>(p.releases, need(1, "a release"), "release"); const i = pickOne<any>(r.items, need(2, "an item"), "item");
      await api("PATCH", `/v1/projects/${enc(pid)}/releases/${r.id}/items/${i.id}/stages`, { stage: need(3, "a stage"), status: need(4, "a status"), ...(args[5] !== undefined ? { note: args[5] } : {}) });
      return console.log(`${i.title} · ${args[3]} → ${args[4]}`);
    }
    case "add-release": await api("POST", `/v1/projects/${enc(need(0, "a project id"))}/releases`, { name: need(1, "a name"), date: need(2, "a date") }); return console.log(`added ${args[1]}`);
    case "add-item": {
      const pid = need(0, "a project id"); const r = pickOne<any>((await project(pid)).releases, need(1, "a release"), "release");
      await api("POST", `/v1/projects/${enc(pid)}/releases/${r.id}/items`, { title: need(2, "a title") });
      return console.log(`added ${args[2]}`);
    }
    case "ship": {
      const pid = need(0, "a project id"); const r = pickOne<any>((await project(pid)).releases, need(1, "a release"), "release");
      await api("PATCH", `/v1/projects/${enc(pid)}/releases/${r.id}`, { shipped: true });
      return console.log(`shipped ${r.name}`);
    }
    case "ask-log": {
      const conv = need(0, "a conversation id");
      const seen = (await messages(conv)).at(-1)?.id ?? null;
      writeAsks(logAsk(readAsks(), { conv, feature: need(1, "the feature"), who: args[2] ?? "", context: args[3], seen, at: new Date().toISOString() }));
      return console.log(`waiting for ${args[2] || "a reply"} on ${args[1]}`);
    }
    case "replies": {
      const asks = readAsks();
      for (const ask of asks) {
        const all = await messages(ask.conv);
        const fresh = freshReplies(all, ask.seen, account.user.id);
        for (const m of fresh) console.log(`REPLY | ${ask.feature} | ${m.user?.name} | ${ask.conv} | ${m.id} | ${oneLine(m.text)}${m.attachments?.length ? ` [${m.attachments.length} attachment(s)]` : ""}`);
        if (fresh.length && ask.context) console.log(`CONTEXT | ${ask.feature} | ${ask.context}`);
        if (args.includes("--mark") && all.length) ask.seen = all.at(-1)!.id;
      }
      if (args.includes("--mark")) writeAsks(asks);
      return;
    }
    default: throw new Error(`Unknown command "${cmd}".\n${HELP}`);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv.slice(3)).catch(error => { console.error(error.message ?? String(error)); process.exit(1); });
}
