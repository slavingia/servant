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
};

/** Reconcile one response against the latest saved account, retaining offline settings until it arrives. */
export function reconcileAccountProfile(latest: Account, profile: ServerProfile, keepDeepWork = false): Account {
  if (!profile.user?.id) return latest;
  const user = { ...latest.user, id: profile.user.id, name: profile.user.name ?? latest.user.name, role: profile.user.role ?? latest.user.role };
  const serverName = profile.server?.name || latest.serverName;
  const features = normalizeFeatures(profile.features);
  const theme = normalizeTheme(profile.theme);
  const banner = bannerFromServer(profile.banner);
  const deepWork = keepDeepWork ? !!latest.deepWork : deepWorkFromServer(profile.deepWork);
  const recordsKept = profile.recordsKept === true;
  if (user.id === latest.user.id && user.name === latest.user.name && user.role === latest.user.role && serverName === latest.serverName && latest.features && sameFeatures(latest.features, features) && latest.theme?.primaryColor === theme.primaryColor && !!latest.deepWork === deepWork && latest.banner?.message === banner?.message && !!latest.recordsKept === recordsKept) return latest;
  return { ...latest, user, serverName, features, theme, deepWork, banner, recordsKept };
}
