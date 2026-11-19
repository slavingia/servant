// The roles a person can say they have, in the tour and on their profile. This is the one list: edit it here and
// the tour, the profile and the People list follow, because the server sends it to the app (GET /v1/tour).
//
// A role describes someone's work. It tailors the tour's example and the first asks it suggests, and it shows
// beside their name. It is never read by anything that decides what an agent may do: not the access level
// (`agentTier`), the daily limit, entitlements, approvals or the network gate. A person sets their own
// (PATCH /v1/people/me), so if it opened anything, people would be giving themselves access.
//
// Each role has:
//   id      what is stored on the person (`jobRole`). Keep it once people have chosen it.
//   label   what people see.
//   task    a small piece of work, read after "Ask for": the tour's example.
//   asks    first things to ask the agent. Each opens a new agent chat with the words filled in, so write
//           them to work on any agent, including one that can only read and write text.
export const JOB_ROLES = [
  { id: "designer", label: "Designer", task: "three ways to simplify a sign-up form",
    asks: ["Give me three ways to simplify a sign-up form, with the trade-offs of each.", "List the accessibility checks to run before I hand off a design.", "Write alt text for an image I'll describe to you."] },
  { id: "researcher", label: "Researcher", task: "a discussion guide for five interviews",
    asks: ["Draft a discussion guide for five 30-minute interviews about a new feature.", "Turn the interview notes I paste into themes, with a quote for each.", "Write a screener for recruiting people who are new to a service."] },
  { id: "engineer", label: "Engineer", task: "a review of a function you paste",
    asks: ["Review the function I paste for bugs and missing tests.", "Explain the error I paste and how to find its cause.", "Outline a plan to split a large pull request into small ones."] },
  { id: "content", label: "Content", task: "a plain-language rewrite of a paragraph",
    asks: ["Rewrite the paragraph I paste in plain language.", "Give me five clearer versions of an error message I'll paste.", "Check the page I paste for jargon and long sentences."] },
  { id: "product", label: "Product", task: "a one-page brief for a feature",
    asks: ["Draft a one-page brief for a feature: the problem, who it is for and how we will know it worked.", "Turn the notes I paste into user stories with acceptance criteria.", "List the risks and open questions for a launch I'll describe."] },
  { id: "manager", label: "Manager", task: "a status update from your notes",
    asks: ["Draft a weekly status update from the bullet points I paste.", "Summarize what my team should know from the notes I paste.", "Help me write clear, kind feedback on a teammate's proposal."] },
  { id: "other", label: "Other", task: "a summary of a document you paste",
    asks: ["What can you help me with here?", "Summarize the document I paste in five bullet points.", "Draft a short, clear email from my notes."] },
];

const byId = new Map(JOB_ROLES.map(role => [role.id, role]));

/** Whether this is a role on the list. */
export const validJobRole = id => typeof id === "string" && byId.has(id);

/** The role a person chose, as others see it: `{ id, label }`, or null when they chose none or it left the list. */
export function jobRoleOf(user) {
  const role = byId.get(user?.jobRole);
  return role ? { id: role.id, label: role.label } : null;
}
