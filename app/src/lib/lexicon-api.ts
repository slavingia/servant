import { request, type Account } from "./server";
import type { GlossaryEntry, GlossaryFields } from "./abbreviations";

export type ShortcutFields = Pick<GlossaryFields, "abbreviation" | "fullName">;
export type LexiconEntry = GlossaryEntry & { canEdit: boolean };
const route = (id?: string) => `/v1/lexicon${id ? `/${encodeURIComponent(id)}` : ""}`;

export const lexiconApi = {
  list: (account: Account, signal?: AbortSignal): Promise<{ entries: LexiconEntry[]; canWrite: boolean }> =>
    request(account, route(), { signal }).then(response => response.json()),
  create: (account: Account, fields: ShortcutFields, signal?: AbortSignal): Promise<LexiconEntry> =>
    request(account, route(), { method: "POST", body: JSON.stringify(fields), signal }).then(response => response.json()).then(value => value.entry),
  update: (account: Account, id: string, fields: Partial<ShortcutFields>): Promise<LexiconEntry> =>
    request(account, route(id), { method: "PATCH", body: JSON.stringify(fields) }).then(response => response.json()).then(value => value.entry),
  /**
   * Abbreviations in a message just sent that nobody has defined. The server adds Agent's guess for each, marked
   * as a guess, and gives the sender a to-do to check it. Nothing waits on this: the message has already gone.
   */
  learn: (account: Account, terms: string[], text: string, signal?: AbortSignal): Promise<{ entries: LexiconEntry[]; todos: number }> =>
    request(account, `${route()}/learn`, { method: "POST", body: JSON.stringify({ terms, text }), signal }).then(response => response.json()),
  remove: (account: Account, id: string): Promise<{ ok: boolean }> =>
    request(account, route(id), { method: "DELETE" }).then(response => response.json()),
};
