import type { Account } from "./accounts-store.ts";
import { normalizeFeatures, sameFeatures } from "./features.ts";
import { bannerFromServer } from "./banner.ts";
import { deepWorkFromServer } from "./deep-work.ts";
import { normalizeTheme } from "./theme-colors.ts";

export type ServerProfile = {
  user?: Partial<Account["user"]>;
  server?: { name?: string };
  features?: unknown;
  theme?: unknown;
  banner?: unknown;
  deepWork?: unknown;
  session?: unknown;
  recordsKept?: unknown;
  fileDrop?: unknown;
  tour?: unknown;
};

/** `{ id, label }` when the server sent a role, else nothing. */
export function jobRoleFromServer(raw: unknown): { id: string; label: string } | undefined {
  const role = raw as { id?: unknown; label?: unknown } | null | undefined;
  return role && typeof role === "object" && typeof role.id === "string" && role.id && typeof role.label === "string" && role.label ? { id: role.id, label: role.label } : undefined;
}

/** Whether the server says the tour is due; undefined when it says nothing about a tour. */
export function tourDueFromServer(raw: unknown): boolean | undefined {
  const due = (raw as { due?: unknown } | null | undefined)?.due;
  return typeof due === "boolean" ? due : undefined;
}

/** Reconcile one response against the latest saved account, retaining offline settings until it arrives. */
export function reconcileAccountProfile(latest: Account, profile: ServerProfile, keepDeepWork = false): Account {
  if (!profile.user?.id) return latest;
  const user: Account["user"] = { ...latest.user, id: profile.user.id, name: profile.user.name ?? latest.user.name, role: profile.user.role ?? latest.user.role };
  // The role they chose for themselves comes with every profile; one that is gone from the answer is gone here.
  const jobRole = jobRoleFromServer(profile.user.jobRole);
  if (jobRole) user.jobRole = jobRole; else delete user.jobRole;
  // Only a server with the tour says whether it is due; an older one leaves the account as it was.
  // A tour closed on this device stays closed until the server agrees, even if it could not be told at the time.
  const said = tourDueFromServer(profile.tour);
  const tourClosed = latest.tourClosed === true && said !== false;
  const tourDue = tourClosed ? false : said ?? latest.tourDue;
  const serverName = profile.server?.name || latest.serverName;
  const features = normalizeFeatures(profile.features);
  const theme = normalizeTheme(profile.theme);
  const banner = bannerFromServer(profile.banner);
  const deepWork = keepDeepWork ? !!latest.deepWork : deepWorkFromServer(profile.deepWork);
  const recordsKept = profile.recordsKept === true;
  const fileDrop = profile.fileDrop === true;
  if (user.id === latest.user.id && user.name === latest.user.name && user.role === latest.user.role && serverName === latest.serverName && latest.features && sameFeatures(latest.features, features) && latest.theme?.primaryColor === theme.primaryColor && !!latest.deepWork === deepWork && latest.banner?.message === banner?.message && !!latest.recordsKept === recordsKept && !!latest.fileDrop === fileDrop && latest.user.jobRole?.id === jobRole?.id && latest.user.jobRole?.label === jobRole?.label && latest.tourDue === tourDue && !!latest.tourClosed === tourClosed) return latest;
  const { tourClosed: _closed, ...kept } = latest;
  return { ...kept, user, serverName, features, theme, deepWork, banner, recordsKept, fileDrop, ...(tourDue === undefined ? {} : { tourDue }), ...(tourClosed ? { tourClosed } : {}) };
}
