import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RESEARCH_COLLABORATORS,
  accessLabel,
  collaborationNotice,
  collaboratorCandidates,
  collaboratorPayload,
  filterCandidates,
  isResearchPlan,
  sharedResearchPlans,
  withCollaborator,
  withoutCollaborator,
} from "./research-collaborators.ts";
import type { Chat, ResearchCollaborator } from "./server.ts";

const people = [
  { id: "me", name: "Ash", agentTier: 4 },
  { id: "agent", name: "Servant", agent: true },
  { id: "r1", name: "Rae", agentTier: 4 },
  { id: "r2", name: "Bo", agentTier: 4 },
  { id: "m1", name: "Mo", agentTier: 1 },
  { id: "admin", name: "Ada", owner: true, agentTier: 4 },
];

test("only research study plans take collaborators", () => {
  assert.equal(isResearchPlan({ title: "[Research study] Refund letters" }), true);
  assert.equal(isResearchPlan({ title: "[Research synthesis] Refund letters" }), false);
  assert.equal(isResearchPlan({ title: "Research study about refunds" }), false);
});

test("candidates exclude you, the agent, and people already added; ineligible people explain why", () => {
  const list = collaboratorCandidates(people, { me: "me", current: [{ id: "r2" }] });
  assert.deepEqual(list.map(p => [p.id, p.eligible, p.reason]), [
    ["r1", true, undefined],
    ["admin", false, "Admins can already view every plan"],
    ["m1", false, "Needs Researcher access"],
  ]);
  assert.deepEqual(filterCandidates(list, "  RA ").map(p => p.id), ["r1"]);
  assert.equal(filterCandidates(list, "").length, 3);
});

test("adding, changing, and removing collaborators sends only ids and access", () => {
  let list: ResearchCollaborator[] = [];
  list = withCollaborator(list, { id: "r1", name: "Rae" }, "view");
  list = withCollaborator(list, { id: "r2", name: "Bo" }, "edit");
  list = withCollaborator(list, { id: "r1", name: "Rae" }, "edit");
  assert.deepEqual(collaboratorPayload(list), [{ id: "r1", access: "edit" }, { id: "r2", access: "edit" }]);
  assert.deepEqual(collaboratorPayload(withoutCollaborator(list, "r1")), [{ id: "r2", access: "edit" }]);
  let full: ResearchCollaborator[] = [];
  for (let i = 0; i < MAX_RESEARCH_COLLABORATORS + 2; i++) full = withCollaborator(full, { id: `p${i}`, name: `P${i}` }, "view");
  assert.equal(full.length, MAX_RESEARCH_COLLABORATORS, "the list stops at the server's cap");
});

test("labels and notices never imply validation and name who pays for edits", () => {
  assert.equal(accessLabel("view"), "Can view");
  assert.equal(accessLabel("edit"), "Can edit");
  assert.match(collaborationNotice("edit", "Pia").body, /your own token allowance/);
  assert.doesNotMatch(collaborationNotice("view", "Pia").body + collaborationNotice("edit", "Pia").body, /validat|approv|proven/i);
});

test("shared plans list only study plans someone opened to you", () => {
  const chat = (id: string, title: string, updatedAt: number, extra: Partial<Chat> = {}): Chat => ({ id, title, createdAt: 0, updatedAt, ...extra });
  const others = [
    chat("a", "[Research study] Older", 1, { collaboration: { access: "view" } }),
    chat("b", "[Research study] Newer", 2, { collaboration: { access: "edit" } }),
    chat("c", "[Research study] Workspace share", 3, { shared: true }),
    chat("d", "[Research synthesis] Not a plan", 4, { collaboration: { access: "view" } }),
  ];
  assert.deepEqual(sharedResearchPlans(others).map(c => c.id), ["b", "a"]);
});
