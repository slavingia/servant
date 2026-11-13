import { request, type Account } from "./server";
import type { GlossaryEntry, GlossaryFields } from "./abbreviations";

const route = (projectId: string, entryId?: string) => `/v1/projects/${encodeURIComponent(projectId)}/glossary${entryId ? `/${encodeURIComponent(entryId)}` : ""}`;

// Use the same pinned encrypted transport and session errors as the rest of the app.
export const glossaryApi = {
  list: (account: Account, projectId: string, signal?: AbortSignal): Promise<{ entries: GlossaryEntry[]; canWrite: boolean; projectRepo: string }> =>
    request(account, route(projectId), { signal }).then(r => r.json()),
  create: (account: Account, projectId: string, fields: GlossaryFields): Promise<GlossaryEntry> =>
    request(account, route(projectId), { method: "POST", body: JSON.stringify(fields) }).then(r => r.json()).then(d => d.entry),
  update: (account: Account, projectId: string, entryId: string, fields: Partial<GlossaryFields>): Promise<GlossaryEntry> =>
    request(account, route(projectId, entryId), { method: "PATCH", body: JSON.stringify(fields) }).then(r => r.json()).then(d => d.entry),
  remove: (account: Account, projectId: string, entryId: string): Promise<{ ok: boolean }> =>
    request(account, route(projectId, entryId), { method: "DELETE" }).then(r => r.json()),
};
