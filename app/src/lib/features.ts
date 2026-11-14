import { createContext, useContext } from "react";

// Which parts of the app this server uses (server/features.mjs, docs/features.md "Features an instance
// doesn't use"). Every flag is on unless the server said exactly `false`; a server from before
// the flag existed says nothing and gets everything. Screens ask `useFeature("meetings")` and
// hide their entry points; the server refuses the routes as well, so an old build just sees errors.
// `people` (the People directory and invites) is not a server flag: the server never turns it off, only Deep work does.
export type FeatureName = "channels" | "directMessages" | "meetings" | "secureInbox" | "people";
export type Features = Record<FeatureName, boolean>;
export const FEATURE_NAMES: FeatureName[] = ["channels", "directMessages", "meetings", "secureInbox", "people"];
/** The flags the server sends and an account stores; `people` is always on there. */
export type ServerFeatures = Omit<Features, "people">;
const SERVER_FEATURE_NAMES = FEATURE_NAMES.filter((name): name is keyof ServerFeatures => name !== "people");
export const ALL_FEATURES: Features = { channels: true, directMessages: true, meetings: true, secureInbox: true, people: true };

export function normalizeFeatures(raw: unknown): Features {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { channels: given.channels !== false, directMessages: given.directMessages !== false, meetings: given.meetings !== false, secureInbox: given.secureInbox !== false, people: true };
}

export const sameFeatures = (a: ServerFeatures, b: ServerFeatures) => SERVER_FEATURE_NAMES.every(name => a[name] === b[name]);

/** Deep work (deep-work.ts) hides channels, direct messages, meetings, the secure inbox and People on top of the server's flags. It only hides: a flag the server has off stays off. */
export const withDeepWork = (features: Features, on: boolean): Features => on ? { channels: false, directMessages: false, meetings: false, secureInbox: false, people: false } : features;

export type TabName = "channels" | "messages" | "agent" | "members" | "you";
export type TabHref = "/channels" | "/messages" | "/agent" | "/members" | "/you";
export const TAB_HREF: Record<TabName, TabHref> = { channels: "/channels", messages: "/messages", agent: "/agent", members: "/members", you: "/you" };

/** The tabs this server shows, in order. Without channels (Home) the agent comes first. */
export function tabsFor(features: Features): TabName[] {
  const talk: TabName[] = features.channels ? ["channels", "messages", "agent"] : ["agent", "messages"];
  return [...talk.filter(tab => tab !== "messages" || features.directMessages), ...(features.people ? ["members" as const] : []), "you"];
}

/** Where the app lands after sign-in, on a notification with nowhere to go, and when Back has no history. */
export const landingHref = (features: Features): "/channels" | "/agent" => features.channels ? "/channels" : "/agent";

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
