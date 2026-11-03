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

export function toolStatusLine(toolName, { full = true } = {}) {
  if (!full || typeof toolName !== "string" || !toolName) return WORKING_LINE;
  const name = toolName.trim().toLowerCase();
  if (name.startsWith("mcp_")) return "Using a connected app";
  return LINES.find(([pattern]) => pattern.test(name))?.[1] ?? WORKING_LINE;
}
