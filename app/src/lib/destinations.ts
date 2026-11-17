import { anyTalk, type FeatureName, type Features } from "./features.ts";

// Every place a person can go, once. The sidebar (wide windows), You (a phone has no sidebar) and search all read
// this list, so a place has one name, one icon and one position everywhere, and a new place is added in one line.
// Before it, each of the three kept its own list: "Saved" in the sidebar was "Saved messages" on You and in search,
// search did not know To-dos, Meetings or Text shortcuts (now the wiki's Abbreviations page), and each new place was added at a different position.
//
// Three groups, in the order a day uses them: where people talk, your own work, and the team's.
export type DestinationGroup = "talk" | "work" | "team";
export const GROUP_TITLE: Record<DestinationGroup, string> = { talk: "Conversations", work: "Your work", team: "Team" };

export type Destination = {
  id: string;
  /** The one name for this place. */
  label: string;
  /** An AppIcon name; no two places share one. */
  icon: string;
  path: string;
  group: DestinationGroup;
  /** A server feature without which the place would be a dead link; "talk" means channels or direct messages. */
  needs?: FeatureName | "talk";
  /** Only for people who may view surveys. */
  surveys?: true;
  /** Only for the owner. */
  owner?: true;
  /** In the sidebar of a wide window. Places reached from You's page there (usage, invites, the archive) are not. */
  sidebar: boolean;
  /** On You. The tabs are not: on a phone they are already on screen. */
  you: boolean;
  /** How search describes and finds it. */
  detail: string;
  keywords: string;
};

export const DESTINATIONS: Destination[] = [
  { id: "home", label: "Home", icon: "home", path: "/channels", group: "talk", needs: "home", sidebar: true, you: false, detail: "Projects, channels and recent conversations", keywords: "channels home" },
  { id: "agent", label: "Agent", icon: "sparkles", path: "/agent", group: "talk", sidebar: true, you: false, detail: "Your private agent chats", keywords: "assistant ai help ask" },
  { id: "messages", label: "Chats", icon: "chat", path: "/messages", group: "talk", needs: "directMessages", sidebar: true, you: false, detail: "Direct and group conversations", keywords: "chats dm dms direct messages" },
  { id: "inbox", label: "Cases", icon: "lock", path: "/inbox", group: "talk", needs: "secureInbox", sidebar: true, you: true, detail: "Conversations with the public, team notes and follow-ups", keywords: "cases casework follow-up task notes inbox support visitor guest live chat external contact customer public" },
  { id: "todos", label: "To-dos", icon: "check", path: "/todos", group: "work", sidebar: true, you: true, detail: "To-dos for you and your projects", keywords: "todo to-do task tasks checklist" },
  { id: "saved", label: "Saved", icon: "bookmark", path: "/saved", group: "work", sidebar: true, you: true, detail: "Messages you saved to follow up, and your work log", keywords: "save saved later bookmark todo to-do checklist follow up completed work log" },
  { id: "meetings", label: "Meetings", icon: "meetings", path: "/meetings", group: "work", needs: "meetings", sidebar: true, you: true, detail: "Calls, recordings and their notes", keywords: "meeting call record recording notes" },
  { id: "archive", label: "Archived", icon: "archive", path: "/archived-channels", group: "work", needs: "talk", sidebar: false, you: true, detail: "Channels and messages you archived", keywords: "archive archived restore channels messages" },
  { id: "members", label: "People", icon: "people", path: "/members", group: "team", needs: "people", sidebar: true, you: true, detail: "Everyone on your server", keywords: "people members directory" },
  { id: "entitlements", label: "Entitlements", icon: "key", path: "/entitlements", group: "team", sidebar: false, you: true, detail: "What your agent may reach, and the requests waiting on you", keywords: "entitlements access permissions approve approval request grant manager network hosts gate sandbox" },
  { id: "invite", label: "Invite people", icon: "addPerson", path: "/invite", group: "team", needs: "people", owner: true, sidebar: false, you: true, detail: "Share an invite to your server", keywords: "people invite join link teammates" },
  // Surveys and the responses to them are one place, with a tab for each on the screen.
  { id: "feedback", label: "Feedback", icon: "smile", path: "/surveys", group: "team", surveys: true, sidebar: true, you: true, detail: "Surveys and the private responses to review", keywords: "feedback survey surveys queue responses review faces ratings results share private" },
  { id: "wiki", label: "Wiki", icon: "book", path: "/wiki", group: "team", sidebar: true, you: true, detail: "Pages your team writes together, and the abbreviations that expand as you type", keywords: "wiki pages documents docs notes knowledge handbook guide text shortcuts abbreviations lexicon glossary expand" },
  { id: "feed", label: "Agent feed", icon: "activity", path: "/feed", group: "team", sidebar: false, you: true, detail: "What the agent did lately: messages, releases and checks", keywords: "feed activity agent log history did done shipped sent ran recent" },
  { id: "loops", label: "Loops", icon: "loop", path: "/loops", group: "team", sidebar: false, you: true, detail: "What the agent does on its own, every hour, day and week", keywords: "loops automations schedule scheduled recurring cron releases hourly daily weekly agent" },
  { id: "usage", label: "Agent usage", icon: "clock", path: "/leaderboard", group: "team", sidebar: false, you: true, detail: "How much each person uses the agent", keywords: "agent usage tokens leaderboard" },
];

export type Viewer = { features: Features; owner: boolean; canViewSurveys: boolean };

/** Whether this person, on this server, has this place. */
export const reachable = (place: Destination, viewer: Viewer) =>
  (!place.owner || viewer.owner) && (!place.surveys || viewer.canViewSurveys)
  && (!place.needs || (place.needs === "talk" ? anyTalk(viewer.features) : viewer.features[place.needs]));

/** The places for the sidebar or for You, grouped and in order; a group with nothing in it is left out. */
export function destinationGroups(where: "sidebar" | "you", viewer: Viewer): { group: DestinationGroup; title: string; places: Destination[] }[] {
  return (["talk", "work", "team"] as const)
    .map(group => ({ group, title: GROUP_TITLE[group], places: DESTINATIONS.filter(place => place.group === group && place[where] && reachable(place, viewer)) }))
    .filter(entry => entry.places.length > 0);
}

/** Whether the sidebar should show a place as the one that is open. */
export function placeIsOpen(place: Destination, pathname: string, kind: string | undefined, features: Features): boolean {
  switch (place.id) {
    case "home": return pathname === "/channels" || pathname === "/";
    case "agent": return pathname === "/agent" || (!features.home && pathname === "/") || pathname.startsWith("/chat/") || (pathname === "/files" && kind === "chat");
    case "members": return pathname === "/members" || pathname === "/invite";
    case "meetings": return pathname === "/meetings" || pathname.startsWith("/meetings/");
    case "inbox": return pathname === "/inbox" || pathname.startsWith("/inbox/");
    case "feedback": return pathname === "/surveys" || pathname === "/queue";
    case "wiki": return pathname === "/wiki" || pathname === "/lexicon";
    default: return pathname === place.path;
  }
}
