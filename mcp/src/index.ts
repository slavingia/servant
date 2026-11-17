#!/usr/bin/env node
// Servant MCP server: lets any MCP-capable tool (Claude, Codex, Cursor, your own vibe-coded client)
// read and post in your Servant workspace and run agent chats, as you, over the app's encryption.
//
//   node src/index.ts link "<invite or workspace link>"   sign in once (approve on your phone)
//   node src/index.ts                                     run the MCP server on stdio
//   node src/index.ts code "<what it is for>" [hint]      ask your phone for a one-time code; prints only the code
//                                                          (SERVANT_CODE_LENGTH=6: the phone sends it by itself once complete)
//   node src/index.ts jira-export [file.csv] [project]    write your to-dos as a file Jira's CSV importer reads
//   node src/index.ts jira-keys <jira export.csv>         record which Jira issue each to-do became
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call, link, loadAccount, parseWorkspace, streamAgent, accountFile, requestCode, type Account } from "./client.ts";
import { jiraExport, jiraKeys } from "./jira.ts";

const [cmd, arg, name] = process.argv.slice(2);
if (cmd === "link") {
  if (!arg) { console.error('Usage: servant-mcp link "<invite or workspace link>" [device name]'); process.exit(2); }
  try { await link(parseWorkspace(arg), name || "MCP client"); process.exit(0); }
  catch (e: any) { console.error(e?.code === "expired_device_link" ? "The sign-in code expired before it was approved. Run link again" : e?.message || String(e)); process.exit(1); }
}

// Ask your phone for a one-time code (docs/code-requests.md). Prints only the code, so a script can read it:
//   CODE=$(node src/index.ts code "Login.gov sign-in" "Texted to the number ending 0000")
if (cmd === "code") {
  if (!arg) { console.error('Usage: servant-mcp code "<what it is for>" [hint]'); process.exit(2); }
  const length = Number(process.env.SERVANT_CODE_LENGTH) || undefined;
  try { process.stdout.write((await requestCode(account(), arg, name, { log: console.error, length })) + "\n"); process.exit(0); }
  catch (e: any) { console.error(e?.message || String(e)); process.exit(1); }
}
function account(): Account {
  const a = loadAccount();
  if (!a) throw new Error(`Not signed in. Run: servant-mcp link "<invite or workspace link>" (saves ${accountFile()})`);
  return a;
}
// The batch copy into Jira: one command each way, and then the process ends.
if (cmd === "jira-export" || cmd === "jira-keys") {
  try {
    if (cmd === "jira-export") await jiraExport(account(), arg, name);
    else if (!arg) { console.error("Usage: servant-mcp jira-keys <CSV exported from Jira>"); process.exit(2); }
    else await jiraKeys(account(), arg);
    process.exit(0);
  } catch (e: any) { console.error(e?.message || String(e)); process.exit(1); }
}
const api = <T = any>(method: string, path: string, body?: unknown) => call<T>(account(), method, path, body);
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>) =>
  server.tool(name, description, shape, async (args: any) => {
    try { return ok(await run(args)); }
    catch (e: any) { return { isError: true, content: [{ type: "text" as const, text: e?.message || String(e) }] }; }
  });

const server = new McpServer({ name: "servant", version: "0.1.0" });

// Who you are and who's here.
// Ids come from an LLM, so keep them to the characters real ids use ("..", slashes and the like would reshape the URL).
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "not a valid id");
tool("request_code", "Ask the signed-in person's phone for a one-time code (a text or email sign-in code) and wait until they type it in Servant. Returns the code once. Use it only for a sign-in this person started.",
  { label: z.string().min(1).max(60).describe('What the code is for, e.g. "Login.gov sign-in"'), hint: z.string().max(120).optional().describe("Where the code was sent, without full phone numbers or emails"),
    timeout_seconds: z.number().int().min(60).max(900).optional(),
    length: z.number().int().min(4).max(12).optional().describe("How many characters the code has, when known (Login.gov texts 6). The phone sends it by itself once that many are in") },
  async ({ label, hint, timeout_seconds, length }) => ({ code: await requestCode(account(), label, hint, { timeoutSeconds: timeout_seconds, length }) }));
tool("whoami", "The signed-in person and server.", {}, async () => { const a = account(); return { user: a.user, server: a.serverName, address: a.server }; });
tool("list_people", "Everyone on the server: id, name, role.", {}, async () => (await api("GET", "/v1/people")).people);
tool("set_unlimited_tokens", "Owner only: lift (true) or restore (false) someone's daily agent token limit. Pass their user id from list_people.",
  { user_id: id, unlimited: z.boolean() },
  async ({ user_id, unlimited }) => (await api("PATCH", `/v1/people/${encodeURIComponent(user_id)}`, { unlimitedTokens: unlimited })).person);

// Channels and direct messages.
const slim = (c: any) => ({ id: c.id, kind: c.kind, name: c.name ?? c.title, topic: c.topic || undefined, unread: c.unread, archived: c.archived || undefined });
tool("list_conversations", "Channels and DMs you're in, with unread counts.", { include_archived: z.boolean().optional() }, async ({ include_archived }) =>
  (await api("GET", "/v1/conversations?includeArchived=1")).conversations.filter((c: any) => include_archived || !c.archived).map(slim));
tool("read_messages", "Recent messages in a channel or DM (newest last). Pass before (a message id) to page back.",
  { conversation_id: id, before: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  async ({ conversation_id, before, limit }) => {
    const d = await api("GET", `/v1/conversations/${encodeURIComponent(conversation_id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    const posts = (d.messages || d.posts || []).slice(-(limit ?? 50));
    return posts.map((m: any) => ({ id: m.id, from: m.user?.name ?? m.author ?? m.userId, at: m.at ?? m.createdAt, text: m.text, replies: m.replyCount || undefined, files: m.attachments?.map((f: any) => f.name) }));
  });
tool("read_thread", "A message and its replies.", { conversation_id: id, message_id: id }, async ({ conversation_id, message_id }) => {
  const t = await api("GET", `/v1/conversations/${encodeURIComponent(conversation_id)}/threads/${encodeURIComponent(message_id)}`);
  const view = (m: any) => ({ id: m.id, from: m.user?.name, at: m.at ?? m.createdAt, text: m.text });
  return { root: t.root && view(t.root), replies: (t.replies || []).map(view) };
});
tool("send_message", "Post in a channel or DM, or reply in a thread (thread_root = message id). Mention the agent with @agent.",
  { conversation_id: id, text: z.string().min(1).max(40000), thread_root: z.string().optional() },
  async ({ conversation_id, text, thread_root }) => {
    const d = await api("POST", `/v1/conversations/${encodeURIComponent(conversation_id)}/messages`, { text, ...(thread_root ? { threadRoot: thread_root } : {}) });
    return { id: d.message?.id, conversation_id };
  });
tool("open_dm", "Start (or reopen) a direct message with one or more people by id.", { user_ids: z.array(id).min(1).max(8) },
  async ({ user_ids }) => slim((await api("POST", "/v1/conversations", { kind: "dm", userIds: user_ids })).conversation));
tool("create_channel", "Make a channel. Public channels include everyone.", { name: z.string(), topic: z.string().optional(), private: z.boolean().optional() },
  async ({ name, topic, private: priv }) => slim((await api("POST", "/v1/conversations", { name, topic, private: !!priv })).conversation));
tool("search", "Search channels, people and messages you can see.", { query: z.string().min(2).max(100) },
  async ({ query }) => api("GET", `/v1/search?q=${encodeURIComponent(query)}`));

// Agent chats.
tool("list_agent_chats", "Your agent chats, newest first.", {}, async () =>
  (await api("GET", "/v1/chats")).chats.map((c: any) => ({ id: c.id, title: c.title, shared: c.shared, archived: c.archived || undefined, updatedAt: c.updatedAt })));
tool("new_agent_chat", "Start an agent chat. shared=true lets everyone on the server follow it.", { title: z.string().optional(), shared: z.boolean().optional() },
  async ({ title, shared }) => {
    const chat = (await api("POST", "/v1/chats", title ? { title } : {})).chat;
    if (shared) await api("PATCH", `/v1/chats/${chat.id}`, { shared: true });
    return { id: chat.id, title: chat.title, shared: !!shared };
  });
tool("ask_agent", "Send a message in an agent chat and wait for the reply (can take minutes for real work). If the agent is busy with another message in this chat, this waits its turn.",
  { chat_id: id, text: z.string().min(1).max(100000) },
  async ({ chat_id, text }) => streamAgent(account(), chat_id, text));
tool("read_agent_chat", "The messages in an agent chat.", { chat_id: id }, async ({ chat_id }) =>
  (await api("GET", `/v1/chats/${encodeURIComponent(chat_id)}/messages`)).messages.map((m: any) => ({ id: m.id, role: m.role, at: m.at, text: m.text })));

// Resources: the same data as browsable, linkable context.
server.resource("conversations", "servant://conversations", { mimeType: "application/json", description: "Your channels and DMs" },
  async uri => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify((await api("GET", "/v1/conversations")).conversations.map(slim), null, 2) }] }));

await server.connect(new StdioServerTransport());
