// Agent chat projects: what an agent chat is working on.
//
// Technical people pick a project (or none: "talk to the agent as is").
// People marked as vibe coders always get the design prototypes project
// with instructions for quick, previewable iterations on GitHub Pages.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

// Known projects on this Mac. "path" must exist for a project to be offered.
export const PROJECTS = [
  { id: "mac", name: "Mac", description: "General help on this Mac" },
  { id: "expo", name: "IRS app (Expo)", path: path.join(HOME, "expo-irs"), repo: "Taxpayer-Services-and-Online-Accounts/expo-irs" },
  { id: "servant", name: "Servant", path: path.join(HOME, "servant"), repo: "slavingia/servant" },
  { id: "design-prototypes", name: "Design prototypes", path: path.join(HOME, "servant-vibe", "design-prototypes"),
    repo: "Taxpayer-Services-and-Online-Accounts/design-prototypes", pages: "https://taxpayer-services-and-online-accounts.github.io/design-prototypes/" },
  { id: "hermes", name: "Hermes agent", path: path.join(HOME, "hermes-agent") },
];

export const VIBE_PROJECT = "design-prototypes";

export function availableProjects(exists = p => fs.existsSync(p)) {
  return PROJECTS.filter(p => !p.path || exists(p.path)).map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) }));
}

export function projectById(projectId) {
  return PROJECTS.find(p => p.id === projectId) || null;
}

/** A short folder name for a new vibe-coding prototype. */
export function vibeFolder(chatId) {
  return `vibe-${chatId.replace(/^cht_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}

/**
 * Instructions sent with every turn of a chat (not saved in the transcript).
 * Returns "" for chats with no project.
 */
export function chatInstructions(chat) {
  const project = projectById(chat.project);
  if (!project) return "";
  if (chat.mode === "vibe") {
    const folder = chat.vibeFolder;
    const preview = `${project.pages}${folder}/`;
    return [
      "This chat is a vibe-coding session for someone who isn't a programmer. They describe what they want; you build it.",
      `Work only in the git repository at ${project.path} (GitHub: ${project.repo}), inside the folder ${folder}/. Create it from components/starter.html if it doesn't exist yet. Follow the repository's AGENTS.md, DESIGN.md and components/README.md.`,
      "Each time they ask for something: make the change, keep the folder's README current, run `git pull --rebase` then commit and push to main (only the files in your folder plus regenerated catalog files), then wait for GitHub Pages to publish.",
      `End every reply that changed the prototype with the preview link on its own line, exactly: PREVIEW: ${preview}`,
      "Use plain words. No code, file paths, commands or git terms in your replies unless they ask. Keep replies short: what changed and what they might try next.",
      "Use public information and made-up sample data only. Never touch other folders or other people's prototypes.",
    ].join("\n");
  }
  if (project.id === "mac") return "";
  return `This chat is about the ${project.name} project. Work in ${project.path}${project.repo ? ` (GitHub: ${project.repo})` : ""} unless asked otherwise, and follow its AGENTS.md if it has one.`;
}
