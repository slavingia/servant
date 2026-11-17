import { createContext, useContext } from "react";

// Which parts of the app this server uses (server/features.mjs, docs/features.md "Features an instance
// doesn't use"). Every flag is on unless the server said exactly `false`; a server from before
// the flag existed says nothing and gets everything. Screens ask `useFeature("secureInbox")` and
// hide their entry points; the server refuses the routes as well, so an old build just sees errors.
// `people` (the People directory and invites) is not a server flag: the server never turns it off, only Deep work does.
// `home` (the Home tab) is not a server flag either: it follows channels, and Deep work keeps it (Home then lists only projects).
export type FeatureName = "channels" | "directMessages" | "secureInbox" | "people" | "home";
export type Features = Record<FeatureName, boolean>;
export const FEATURE_NAMES: FeatureName[] = ["channels", "directMessages", "secureInbox", "people", "home"];
/** The flags the server sends and an account stores; `people` is always on there and `home` follows channels. */
export type ServerFeatures = Omit<Features, "people" | "home">;
const SERVER_FEATURE_NAMES = FEATURE_NAMES.filter((name): name is keyof ServerFeatures => name !== "people" && name !== "home");
export const ALL_FEATURES: Features = { channels: true, directMessages: true, secureInbox: true, people: true, home: true };

export function normalizeFeatures(raw: unknown): Features {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { channels: given.channels !== false, directMessages: given.directMessages !== false, secureInbox: given.secureInbox !== false, people: true, home: given.channels !== false };
}

export const sameFeatures = (a: ServerFeatures, b: ServerFeatures) => SERVER_FEATURE_NAMES.every(name => a[name] === b[name]);

/** Deep work (deep-work.ts) hides channels, direct messages, the secure inbox and People on top of the server's flags, and keeps Home for projects. It only hides: a flag the server has off stays off. */
export const withDeepWork = (features: Features, on: boolean): Features => on ? { channels: false, directMessages: false, secureInbox: false, people: false, home: features.home } : features;

export type TabName = "channels" | "messages" | "agent" | "members" | "you";
export type TabHref = "/channels" | "/messages" | "/agent" | "/members" | "/you";
export const TAB_HREF: Record<TabName, TabHref> = { channels: "/channels", messages: "/messages", agent: "/agent", members: "/members", you: "/you" };

/** The tabs this server shows, in order. Without Home the agent comes first. */
export function tabsFor(features: Features): TabName[] {
  const talk: TabName[] = features.home ? ["channels", "messages", "agent"] : ["agent", "messages"];
  return [...talk.filter(tab => tab !== "messages" || features.directMessages), ...(features.people ? ["members" as const] : []), "you"];
}

/** Where the app lands after sign-in, on a notification with nowhere to go, and when Back has no history. */
export const landingHref = (features: Features): "/channels" | "/agent" => features.home ? "/channels" : "/agent";

/** Channels or direct messages: anything that needs a place to talk to people (archive, forwarding, "new message"). */
export const anyTalk = (features: Features) => features.channels || features.directMessages;

/** A conversation the app must not open here: a channel (ch_…) with channels off, a DM (dm_…) with DMs off. */
export function conversationHidden(id: string | undefined, features: Features): boolean {
  if (typeof id !== "string") return false;
  return (id.startsWith("ch_") && !features.channels) || (id.startsWith("dm_") && !features.directMessages);
}

export const FeaturesContext = createContext<Features>(ALL_FEATURES);
/** The signed-in server's flags (everything on while signed out or on an older server). */
export const useFeatures = (): Features => useContext(FeaturesContext);
export const useFeature = (name: FeatureName): boolean => useFeatures()[name];
