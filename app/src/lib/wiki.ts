// The wiki's tree: pages the team writes in Markdown, nested under one another, with one built-in page,
// Abbreviations, that holds the text shortcuts. This file is the logic the screen and its tests share.
export type WikiPageSummary = {
  id: string; parentId: string | null; title: string; position: number;
  createdAt: number; updatedAt: number; updatedByName: string | null; version: number; canDelete: boolean;
  /** A page a part of Servant reads. "social-guide" is the page Agent writes social media replies from. */
  kind?: string;
};
export type WikiPage = WikiPageSummary & { body: string };

/** The built-in page. It is not stored with the others: it is the list of shortcuts, shown as a page. */
export const ABBREVIATIONS_PAGE = "abbreviations";
export const ABBREVIATIONS_TITLE = "Abbreviations";
export const UNTITLED = "Untitled";
/** How deep the server lets pages nest (wiki.mjs WIKI_LIMITS.depth), so the tree offers no subpage it would refuse. */
export const WIKI_MAX_DEPTH = 6;

export type WikiRow = {
  id: string; title: string;
  /** 0 for a page at the top. */
  depth: number;
  hasChildren: boolean;
  /** Whether its subpages are showing. */
  open: boolean;
  /** The built-in Abbreviations page: no subpages, no rename, no delete. */
  special: boolean;
  /** What the page is marked as, when a part of Servant reads it (the social media guide). */
  kind?: string;
};

/** The page Agent writes social media replies from (server/social-draft.mjs). */
export const SOCIAL_GUIDE_KIND = "social-guide";
/** What a marked page is used for, said in the tree and at the top of the page. Null for an ordinary page. */
export const wikiMarkNote = (kind: string | undefined): string | null => kind === SOCIAL_GUIDE_KIND
  ? "Agent writes social media replies from this page. When someone changes a draft before it is approved, what the change teaches is added under Learned from edits."
  : null;
export const wikiMarkLabel = (kind: string | undefined): string | null => kind === SOCIAL_GUIDE_KIND ? "Used for social media replies" : null;

const inOrder = (a: WikiPageSummary, b: WikiPageSummary) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * The rows of the tree, top to bottom: Abbreviations first, then every page under its parent in the server's
 * order, leaving out the subpages of a page in `closed`. A page whose parent is gone is shown at the top
 * rather than lost.
 */
export function wikiRows(pages: readonly WikiPageSummary[], closed: ReadonlySet<string> = new Set()): WikiRow[] {
  const known = new Set(pages.map(page => page.id));
  const under = new Map<string | null, WikiPageSummary[]>();
  for (const page of pages) {
    const parent = page.parentId && known.has(page.parentId) && page.parentId !== page.id ? page.parentId : null;
    under.set(parent, [...(under.get(parent) ?? []), page]);
  }
  const rows: WikiRow[] = [{ id: ABBREVIATIONS_PAGE, title: ABBREVIATIONS_TITLE, depth: 0, hasChildren: false, open: false, special: true }];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const page of [...(under.get(parent) ?? [])].sort(inOrder)) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      const children = under.get(page.id) ?? [];
      const open = children.length > 0 && !closed.has(page.id);
      rows.push({ id: page.id, title: page.title || UNTITLED, depth, hasChildren: children.length > 0, open, special: false, ...(page.kind ? { kind: page.kind } : {}) });
      if (open) walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** The pages above this one, from the top down, for the line that says where a page sits. */
export function wikiAncestors(pages: readonly WikiPageSummary[], id: string): WikiPageSummary[] {
  const byId = new Map(pages.map(page => [page.id, page]));
  const path: WikiPageSummary[] = [];
  const seen = new Set([id]);
  for (let at = byId.get(id)?.parentId; at && byId.has(at) && !seen.has(at); at = byId.get(at)!.parentId) { seen.add(at); path.unshift(byId.get(at)!); }
  return path;
}

/** How many pages sit above this one, so the tree can stop offering subpages at the server's limit. */
export const wikiDepth = (pages: readonly WikiPageSummary[], id: string) => wikiAncestors(pages, id).length + 1;

/** The pages that must be open for this one to be visible in the tree. */
export const wikiOpened = (pages: readonly WikiPageSummary[], id: string, closed: ReadonlySet<string>): Set<string> => {
  const next = new Set(closed);
  for (const page of wikiAncestors(pages, id)) next.delete(page.id);
  return next;
};

/** The page a wide window shows when none is chosen: the first the team wrote, or Abbreviations when there is none. */
export const wikiLanding = (pages: readonly WikiPageSummary[]) => wikiRows(pages).find(row => !row.special)?.id ?? ABBREVIATIONS_PAGE;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Edited by Ana Ruiz · 3 Nov" (with the year when it is not this one). */
export function wikiEditedLine(page: Pick<WikiPageSummary, "updatedAt" | "updatedByName">, now = Date.now()): string {
  const at = new Date(page.updatedAt), today = new Date(now);
  const day = at.toDateString() === today.toDateString() ? "today" : `${at.getDate()} ${MONTHS[at.getMonth()]}${at.getFullYear() === today.getFullYear() ? "" : ` ${at.getFullYear()}`}`;
  return `Edited${page.updatedByName ? ` by ${page.updatedByName}` : ""} · ${day}`;
}

/** Agent's proposal for a page, and the version of the page it was made from. */
export type WikiDraft = { title: string; body: string; version: number };

/** What the box that asks Agent suggests typing: how to start an empty page, or an example of a change. */
export const wikiAskPlaceholder = (page: Pick<WikiPage, "body">) => page.body.trim()
  ? "What should change? For example: add a section on travel, or make this shorter"
  : "What should this page say? For example: a checklist for someone's first week";

/** What a save sends: only what changed, and the version the person was looking at. Null when nothing changed. */
export function wikiChange(page: Pick<WikiPage, "title" | "body" | "version">, draft: { title: string; body: string }): { title?: string; body?: string; version: number } | null {
  const title = draft.title.trim() || UNTITLED;
  const change = { ...(title !== page.title ? { title } : {}), ...(draft.body !== page.body ? { body: draft.body } : {}) };
  return Object.keys(change).length ? { ...change, version: page.version } : null;
}
