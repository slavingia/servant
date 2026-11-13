import { request, type Account } from "./server";
import type { WikiPage, WikiPageSummary } from "./wiki";

const route = (id?: string) => `/v1/wiki${id ? `/${encodeURIComponent(id)}` : ""}`;
const page = (response: { json(): Promise<unknown> }) => response.json().then(value => (value as { page: WikiPage }).page);

export const wikiApi = {
  list: (account: Account, signal?: AbortSignal): Promise<{ pages: WikiPageSummary[] }> =>
    request(account, route(), { signal }).then(response => response.json()),
  get: (account: Account, id: string, signal?: AbortSignal): Promise<WikiPage> => request(account, route(id), { signal }).then(page),
  create: (account: Account, fields: { title: string; parentId?: string | null }): Promise<WikiPage> =>
    request(account, route(), { method: "POST", body: JSON.stringify(fields) }).then(page),
  update: (account: Account, id: string, fields: { title?: string; body?: string; version: number }): Promise<WikiPage> =>
    request(account, route(id), { method: "PATCH", body: JSON.stringify(fields) }).then(page),
  /** Agent's version of the page with a change made. Nothing is saved; `draft` carries on from an unsaved one. */
  draft: (account: Account, id: string, fields: { instruction: string; draft?: { title: string; body: string } }): Promise<{ draft: { title: string; body: string }; version: number }> =>
    request(account, `${route(id)}/draft`, { method: "POST", body: JSON.stringify(fields) }).then(response => response.json()),
  remove: (account: Account, id: string): Promise<{ ok: boolean }> =>
    request(account, route(id), { method: "DELETE" }).then(response => response.json()),
};
