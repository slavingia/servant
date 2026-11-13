// Plain-language progress lines for the agent's tool calls. Raw tool names
// ("Using execute_code") read like log output, so people see what the agent
// is doing instead. Unknown tools fall back to a neutral line.
const LINES = [
  [/^terminal$|^process$|^read_terminal|^close_terminal/, "Running a command"],
  [/^execute_code$|^code_execution/, "Running some code"],
  [/^web_search$/, "Searching the web"],
  [/^web_extract$/, "Reading a web page"],
  [/^browser/, "Using the browser"],
  [/^read_file$|^read_extract/, "Reading a file"],
  [/^write_file$|^patch$/, "Editing a file"],
  [/^search_files$/, "Looking through files"],
  [/^vision_analyze$/, "Looking at an image"],
  [/^image_generate$/, "Making an image"],
  [/^delegate_task$|^async_delegation/, "Handing off part of the work"],
  [/^session_search$/, "Checking earlier conversations"],
  [/^memory$/, "Saving a note for later"],
  [/^skill_view$|^skills_list$/, "Checking its notes"],
  [/^skill_manage$/, "Updating its notes"],
  [/^todo$/, "Planning the next steps"],
  [/^cronjob$/, "Setting up a schedule"],
  [/^send_message$/, "Sending a message"],
  [/^clarify$/, "Getting ready to ask you something"],
  [/^computer_use/, "Using the Mac"],
];

export const WORKING_LINE = "Working on it";
export const THINKING_LINE = "Thinking";
export const WRITING_LINE = "Writing";

// What the agent is working on (the command, search, file or its reasoning),
// shown to the owner when they open the progress line. Secrets and long
// tokens are masked; anything past a short line is cut.
const SECRETS = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|AKIA|ASIA)[-_A-Za-z0-9]{12,}/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([A-Za-z_]*(?:pass(?:word)?|secret|token|api[_-]?key|auth)[A-Za-z_]*)(\s*[=:]\s*)(?!(?:Bearer|Basic|token)\s)("[^"]*"|'[^']*'|\S+)/gi,
  /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,
  /\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];
export const DETAIL_CHARS = 160;
export function stepDetail(text, max = DETAIL_CHARS) {
  if (typeof text !== "string") return "";
  let line = text.replace(/\s+/g, " ").trim();
  line = line.replace(SECRETS[0], "•••").replace(SECRETS[1], "$1 •••").replace(SECRETS[2], "$1$2•••").replace(SECRETS[3], "•••").replace(SECRETS[4], "•••");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function toolStatusLine(toolName, { full = true } = {}) {
  if (!full || typeof toolName !== "string" || !toolName) return WORKING_LINE;
  const name = toolName.trim().toLowerCase();
  if (name.startsWith("mcp_")) return "Using a connected app";
  return LINES.find(([pattern]) => pattern.test(name))?.[1] ?? WORKING_LINE;
}
