import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROLE_NOTE, STEP_TITLE, TOUR_STEPS, aboutUsd, accessSummary, chargeLead, chargePoints, chosenRole, dataPoints, levelRows, limitPage, stepAfter, stepLabel, swipeTurn, tourOpens, tourRoles, tryPage, type TourFacts } from "./tour.ts";
import { reconcileAccountProfile } from "./session-profile.ts";
import type { Account } from "./accounts-store.ts";
import { ALL_FEATURES } from "./features.ts";

// The one role list is the server's (server/job-roles.mjs); the app is sent it and keeps no copy.
const { JOB_ROLES } = await import(new URL("../../../server/job-roles.mjs", import.meta.url).href) as { JOB_ROLES: unknown[] };
const roles = tourRoles(JOB_ROLES);

const LEVELS = [[1, "Tester", 1], [2, "Business owner", 5], [3, "Software engineer", 20], [4, "User researcher", 5], [5, "Product manager", 5]] as const;
const levels = (perMillion?: number) => LEVELS.map(([tier, name, millions]) => ({ tier, name, tokens: millions * 1_000_000, ...(perMillion === undefined ? {} : { perMillion }) }));
/** A full member (Software engineer) on a server with no approval step, priced at $2.80 a million tokens. */
const member = (change: Partial<TourFacts> = {}): TourFacts => ({
  server: { name: "Example team" }, agentName: "Agent", roles, jobRole: null, seen: false, owner: false,
  agent: { tier: 3, name: "Software engineer", kind: "full" },
  approvals: { asks: false, logged: false, networkGate: false, manager: { name: "Ana Ruiz" } },
  limit: { tokens: 20_000_000, unlimited: false }, price: { perMillion: 2.8 }, today: { tokens: 300_000, usd: 0.84 }, levels: levels(2.8),
  ...change,
});
const owner = (change: Partial<TourFacts> = {}) => member({ owner: true, approvals: { asks: false, logged: false, networkGate: false }, limit: { tokens: null, unlimited: true }, today: { tokens: 700_000, usd: 1.96 }, team: { tokens: 1_000_000, usd: 2.8 }, ...change });
const noAgent = (change: Partial<TourFacts> = {}) => member({ agent: { tier: 0, name: "No agent", kind: "none" }, limit: { tokens: 0, unlimited: false }, price: undefined, today: undefined, ...change });
const everything = (facts: TourFacts) => JSON.stringify([chargePoints(facts), accessSummary(facts), levelRows(facts), limitPage(facts), dataPoints(facts)]);

// ---------- the role list ----------

test("the role list is the server's: short, in order, each with an example and first asks", () => {
  assert.deepEqual(roles.map(role => role.label), ["Designer", "Researcher", "Engineer", "Content", "Product", "Manager", "Other"]);
  for (const role of roles) {
    assert.ok(role.task, role.id);
    assert.ok(role.asks.length >= 2 && role.asks.length <= 4, role.id);
    // Sentence case, plain words, and the app's names for things.
    for (const ask of role.asks) { assert.match(ask, /^[A-Z]/); assert.doesNotMatch(ask, /\bhub\b|\bAI\b|!/i, ask); }
  }
  assert.ok(roles.some(role => role.id === "other"), "someone whose work isn't listed still has a choice");
});

test("a list this build can't read is dropped entry by entry, never guessed at", () => {
  assert.deepEqual(tourRoles(null), []);
  assert.deepEqual(tourRoles("designer"), []);
  assert.deepEqual(tourRoles([{ id: "a", label: "A", task: "x", asks: ["One.", 2, "", "Two."] }, { id: "a", label: "Again" }, { id: "", label: "No id" }, { label: "No id" }, null, { id: "b", label: "B" }]),
    [{ id: "a", label: "A", task: "x", asks: ["One.", "Two."] }, { id: "b", label: "B", task: "", asks: [] }]);
});

test("the chosen role is found by id, and one that left the list is no role", () => {
  assert.equal(chosenRole(member({ jobRole: "designer" }))?.label, "Designer");
  assert.equal(chosenRole(member({ jobRole: "gone" })), null);
  assert.equal(chosenRole(member()), null);
  assert.equal(chosenRole(member({ jobRole: "designer" }), "content")?.label, "Content");
});

// ---------- the role never affects access ----------

test("the role changes the example and the asks, and nothing a page says about access, approvals, cost or data", () => {
  for (const facts of [member(), owner(), noAgent(), member({ agent: { tier: 4, name: "User researcher", kind: "researcher" } }), member({ agent: { tier: 3, name: "Software engineer", kind: "restricted" } }), member({ approvals: { asks: true, logged: true, networkGate: true } })]) {
    const plain = everything(facts);
    for (const role of roles) assert.equal(everything({ ...facts, jobRole: role.id }), plain, role.id);
  }
  // Calling yourself an engineer or a manager is not the Software engineer level, a limit or being a manager.
  const tester = member({ agent: { tier: 1, name: "Tester", kind: "full" }, limit: { tokens: 1_000_000, unlimited: false }, jobRole: "engineer" });
  assert.equal(accessSummary(tester).title, "Tester");
  assert.equal(limitPage(tester).headline, "About $2.80 a day at most");
  assert.equal(accessSummary(noAgent({ jobRole: "manager" })).title, "No agent");
  // It does tailor the two places it is meant to.
  assert.notEqual(chargeLead(member(), chosenRole(member({ jobRole: "designer" }))), chargeLead(member(), chosenRole(member({ jobRole: "engineer" }))));
  assert.notDeepEqual(tryPage(member(), roles[0]!).asks, tryPage(member(), roles[2]!).asks);
});

test("the pages that state access take no role at all", () => {
  // The builders above are called with the facts alone, so a role can't reach them. Keep it so: the screen
  // hands the role only to the example and the asks.
  const source = fs.readFileSync(path.join(import.meta.dirname, "tour.ts"), "utf8");
  for (const name of ["chargePoints", "accessSummary", "levelRows", "limitPage", "dataPoints"]) {
    const signature = source.match(new RegExp(`export function ${name}\\(([^)]*)\\)`))?.[1];
    assert.equal(signature, "facts: TourFacts", name);
    const body = source.slice(source.indexOf(`export function ${name}(`)).split("\n}\n")[0]!;
    assert.doesNotMatch(body, /jobRole|\.roles\b|chosenRole/, name);
  }
  const screen = fs.readFileSync(path.join(import.meta.dirname, "../app/tour.tsx"), "utf8");
  // The only thing the screen sends about a role is the person's own choice.
  assert.match(screen, /api\.setJobRole\(account, /);
  assert.doesNotMatch(screen, /setAgentTier|setDailyLimit|askForEntitlement|decideEntitlement|setManager/);
  assert.ok(screen.includes("ROLE_NOTE"));
  assert.equal(ROLE_NOTE, "Your role tailors tips. Your owner sets what the agent can do.");
});

// ---------- daily cost ----------

test("each level's own limit is said in dollars and tokens", () => {
  const at = (millions: number) => limitPage(member({ limit: { tokens: millions * 1_000_000, unlimited: false }, today: undefined }));
  assert.deepEqual(at(1), { headline: "About $2.80 a day at most", lines: ["Your limit is 1 million tokens a day. It resets at midnight.", "At the limit the agent stops for the day. An owner can change it."], note: "Dollar figures are estimates from token counts, not a bill." });
  assert.equal(at(5).headline, "About $14 a day at most");
  assert.equal(at(20).headline, "About $56 a day at most");
  assert.equal(at(50).headline, "About $140 a day at most");
  assert.equal(at(5).lines[0], "Your limit is 5 million tokens a day. It resets at midnight.");
  // A dearer agent: the same tokens cost more.
  assert.equal(limitPage(member({ price: { perMillion: 11.2 } })).headline, "About $220 a day at most");
});

test("today so far sits beside the limit", () => {
  assert.equal(limitPage(member()).lines[1], "Today: about $0.80 of about $56");
  assert.equal(limitPage(member({ today: { tokens: 0, usd: 0 } })).lines[1], "Today: $0 of about $56");
  assert.equal(limitPage(member({ today: { tokens: 9_000, usd: 0.03 } })).lines[1], "Today: under $0.10 of about $56");
  assert.equal(limitPage(member({ limit: { tokens: 5_000_000, unlimited: false }, today: { tokens: 400_000, usd: 1.2 } })).lines[1], "Today: about $1.20 of about $14");
});

test("no limit says so", () => {
  const page = limitPage(member({ limit: { tokens: null, unlimited: true } }));
  assert.equal(page.headline, "No daily limit");
  assert.deepEqual(page.lines, ["Today: about $0.80 so far", "An owner turned your limit off. They pay for what you use."]);
});

test("an owner has no limit and sees what the team used today", () => {
  const page = limitPage(owner());
  assert.equal(page.headline, "No limit; you pay for what the team uses");
  assert.deepEqual(page.lines, ["Team today: about $2.80", "You today: about $2", "You set each person's daily limit in People."]);
  assert.equal(page.note, "Dollar figures are estimates from token counts, not a bill.");
  // The team's total isn't there: the line is left out.
  assert.deepEqual(limitPage(owner({ team: undefined })).lines, ["You today: about $2", "You set each person's daily limit in People."]);
});

test("no agent says so, and how to ask", () => {
  const page = limitPage(noAgent());
  assert.equal(page.headline, "No agent, so nothing to spend");
  assert.match(page.lines.join(" "), /Ask an owner to turn it on/);
  assert.doesNotMatch(JSON.stringify(page), /\$|tokens/);
});

test("a number the server left out is a line left out, never an invented one", () => {
  // No price: tokens, no dollars anywhere.
  const unpriced = limitPage(member({ price: undefined, today: { tokens: 300_000 } }));
  assert.deepEqual(unpriced, { headline: "20 million tokens a day", lines: ["It resets at midnight.", "Today: 300K of 20M tokens", "At the limit the agent stops for the day. An owner can change it."], note: "" });
  // No count for today: nothing about today.
  const quiet = limitPage(member({ today: undefined }));
  assert.equal(quiet.lines.some(line => /Today/.test(line)), false);
  assert.equal(quiet.headline, "About $56 a day at most");
  // A price but no dollars for today: today in tokens rather than a made-up amount.
  assert.equal(limitPage(member({ today: { tokens: 300_000 } })).lines[1], "Today: 300K of 20M tokens");
  assert.deepEqual(limitPage(owner({ today: undefined, team: { tokens: 1_200_000 } })), { headline: "No limit; you pay for what the team uses", lines: ["Team today: 1.2M tokens", "You set each person's daily limit in People."], note: "" });
  assert.deepEqual(limitPage(member({ limit: { tokens: null, unlimited: true }, today: undefined })).lines, ["An owner turned your limit off. They pay for what you use."]);
  // A limit that didn't arrive: the page has nothing to say, and the screen shows nothing.
  assert.deepEqual(limitPage(member({ limit: { tokens: null, unlimited: false } })), { headline: "", lines: [], note: "" });
  assert.equal(aboutUsd(undefined), "");
  assert.equal(aboutUsd(NaN), "");
  assert.equal(aboutUsd(-1), "");
});

test("the levels are listed as People lists them, with this person's marked and each one's cost", () => {
  const rows = levelRows(member());
  assert.deepEqual(rows.map(row => row.label), ["Tester", "Business owner", "Product manager", "User researcher", "Software engineer"]);
  assert.deepEqual(rows.filter(row => row.mine).map(row => row.label), ["Software engineer"]);
  assert.deepEqual(rows.map(row => row.cost), ["up to about $2.80 a day", "up to about $14 a day", "up to about $14 a day", "up to about $14 a day", "up to about $56 a day"]);
  assert.deepEqual(levelRows(member({ levels: levels() })).map(row => row.cost)[0], "up to 1 million tokens a day");
  // An owner sets levels and has none marked; a restricted server's levels don't describe its agents.
  assert.equal(levelRows(owner()).some(row => row.mine), false);
  assert.deepEqual(levelRows(member({ agent: { tier: 3, name: "Software engineer", kind: "restricted" } })), []);
  assert.deepEqual(levelRows(member({ levels: [] })), []);
});

// ---------- approvals, access and data: true to this server ----------

test("approvals are claimed only when this person's agent is checked", () => {
  const said = (facts: TourFacts) => chargePoints(facts).map(point => point.title);
  assert.deepEqual(said(member()), ["Stop at any time", "No approval step on this server"]);
  const asks = member({ approvals: { asks: true, logged: true, networkGate: false, manager: { name: "Ana Ruiz" } } });
  assert.deepEqual(said(asks), ["Stop at any time", "It asks before it touches files or GitHub"]);
  assert.match(chargePoints(asks)[1]!.body, /it stops and Ana Ruiz decides: allow once, allow always or decline/);
  assert.match(chargePoints(member({ approvals: { asks: true, logged: true, networkGate: false } }))[1]!.body, /your manager decides/);
  // Off: no sentence anywhere promises a check.
  assert.doesNotMatch(everything(member()), /asks before|decides|approves/);
  // An owner is never held back, whatever the setting; with the check on, their actions are logged.
  assert.deepEqual(said(owner()), ["Stop at any time", "Your agent acts without asking"]);
  assert.doesNotMatch(chargePoints(owner())[1]!.body, /Agent activity/);
  assert.match(chargePoints(owner({ approvals: { asks: false, logged: true, networkGate: false } }))[1]!.body, /written to Agent activity in Entitlements/);
  // The restricted agents have nothing to check.
  assert.deepEqual(said(member({ agent: { tier: 4, name: "User researcher", kind: "researcher" } })), ["Stop at any time", "Nothing to approve"]);
  assert.deepEqual(said(member({ agent: { tier: 3, name: "Software engineer", kind: "restricted" } })), ["Stop at any time", "Nothing to approve"]);
  assert.deepEqual(said(member({ approvals: { asks: true, logged: true, networkGate: true, manager: { name: "Ana Ruiz" } } })).at(-1), "Other systems need an entitlement");
  assert.deepEqual(said(noAgent()), ["Stop at any time"]);
  assert.match(chargeLead(noAgent(), null), /no agent on this server yet/);
});

test("the access page names this person's real level and what it allows here", () => {
  assert.deepEqual(accessSummary(member()), { title: "Software engineer", body: "Full access: files, the terminal, the web and connected services on the server's computer." });
  assert.deepEqual(accessSummary(member({ agent: { tier: 4, name: "User researcher", kind: "researcher" } })), { title: "User researcher", body: "Web and skills; no GitHub, files or commands" });
  assert.deepEqual(accessSummary(member({ agent: { tier: 1, name: "Tester", kind: "full" } })), { title: "Tester", body: "File GitHub issues only" });
  // The same level on a server that restricts members is not full access, and the page doesn't say it is.
  const restricted = accessSummary(member({ agent: { tier: 3, name: "Software engineer", kind: "restricted" } }));
  assert.equal(restricted.title, "Software engineer");
  assert.match(restricted.body, /No files, terminal, web or connected services/);
  assert.equal(accessSummary(owner()).title, "Owner");
  assert.match(accessSummary(noAgent()).body, /Ask an owner to turn it on/);
});

test("where data goes says what the docs say, and makes no compliance claim", () => {
  const points = dataPoints(member());
  assert.deepEqual(points.map(point => point.title), ["It stays on your team's server", "Encrypted from the app to the server", "The agent sits behind the server", "Agent chats start private", "Your own logins are never shown back"]);
  assert.match(points[0]!.body, /kept on Example team, which your owner runs on a computer they control/);
  // What it does not hide: the owner and the model can read it.
  assert.match(points[0]!.body, /The owner can read what is on it/);
  assert.match(points[2]!.body, /goes to the AI model your owner set up/);
  assert.equal(dataPoints(noAgent()).length, 3);
  for (const facts of [member(), owner(), noAgent()]) {
    assert.doesNotMatch(everything(facts), /complian|FedRAMP|FISMA|HIPAA|certified|approved for|end-to-end|guarantee|\bsecure\b|\bhub\b/i);
  }
});

test("the last page offers the role's asks, to press only when there is an agent", () => {
  const designer = tryPage(member(), chosenRole(member({ jobRole: "designer" })));
  assert.equal(designer.canAsk, true);
  assert.deepEqual(designer.asks, roles.find(role => role.id === "designer")!.asks);
  assert.match(designer.lead, /Nothing is sent until you press Send/);
  // No role chosen: the general asks.
  assert.deepEqual(tryPage(member(), null).asks, roles.find(role => role.id === "other")!.asks);
  const none = tryPage(noAgent(), null);
  assert.equal(none.canAsk, false);
  assert.match(none.lead, /Once an owner turns it on/);
  assert.deepEqual(tryPage(member({ roles: [] }), null).asks, []);
});

// ---------- the steps ----------

test("six steps: the role, the four agreed pages, then first asks", () => {
  assert.deepEqual([...TOUR_STEPS], ["role", "charge", "access", "limit", "data", "try"]);
  assert.equal(stepLabel(0), "Step 1 of 6: What's your role?");
  assert.equal(stepLabel(3), "Step 4 of 6: Your daily limit");
  for (const title of Object.values(STEP_TITLE)) assert.match(title, /^[A-Z][^A-Z]*(@agent)?$/, `sentence case: ${title}`);
  assert.equal(stepAfter(0, -1), 0);
  assert.equal(stepAfter(0, 1), 1);
  assert.equal(stepAfter(5, 1), 5);
  assert.equal(stepAfter(5, -1), 4);
});

test("a sideways swipe turns the page; scrolling and small moves don't", () => {
  assert.equal(swipeTurn(-120, 6), 1, "leftwards: the next page");
  assert.equal(swipeTurn(120, -10), -1, "rightwards: the one before");
  assert.equal(swipeTurn(-30, 0), 0, "too short");
  assert.equal(swipeTurn(-80, 200), 0, "a scroll that drifted sideways");
  assert.equal(swipeTurn(0, 0), 0);
});

// ---------- when it opens ----------

const account: Account = { token: "test-token", serverKey: "test-key", serverUrl: "https://example.gov", serverName: "Example team", user: { id: "usr_pat", name: "Pat Tester", role: "member" }, features: ALL_FEATURES, theme: { primaryColor: "#0071BC" } };

test("it opens once, for someone who just joined", () => {
  const joined = { paired: true, due: true, dismissed: false, pathname: "/channels" };
  assert.equal(tourOpens(joined), true);
  // Someone who was here before, or a server that has no tour: never by itself.
  assert.equal(tourOpens({ ...joined, due: false }), false);
  assert.equal(tourOpens({ ...joined, due: undefined }), false);
  assert.equal(tourOpens({ ...joined, paired: false }), false);
  // Not over joining, signing in or confirming it's you, and not twice over itself.
  for (const pathname of ["/welcome", "/pair", "/sign-in", "/join-server", "/scan", "/reverify", "/tour"]) assert.equal(tourOpens({ ...joined, pathname }), false, pathname);
  for (const pathname of ["/agent", "/you", "/chat/cht_1", "/tours"]) assert.equal(tourOpens({ ...joined, pathname }), true, pathname);
});

test("finishing or skipping closes it for good, even before the server has answered", () => {
  // Skipped or finished: this app remembers at once.
  assert.equal(tourOpens({ paired: true, due: true, dismissed: true, pathname: "/channels" }), false);
  // The server's answer is what the account keeps: due after joining, not due once seen, on every device.
  const due = reconcileAccountProfile(account, { user: account.user, tour: { due: true } });
  assert.equal(due.tourDue, true);
  const seen = reconcileAccountProfile(due, { user: account.user, tour: { due: false } });
  assert.equal(seen.tourDue, false);
  assert.equal(tourOpens({ paired: true, due: seen.tourDue, dismissed: false, pathname: "/channels" }), false);
  // Closed on this device while the server could not be told: it stays closed here whatever the server still
  // says, and the mark is dropped once the server agrees.
  const closed = reconcileAccountProfile({ ...due, tourDue: false, tourClosed: true }, { user: account.user, tour: { due: true } });
  assert.deepEqual([closed.tourDue, closed.tourClosed], [false, true]);
  const agreed = reconcileAccountProfile(closed, { user: account.user, tour: { due: false } });
  assert.deepEqual([agreed.tourDue, "tourClosed" in agreed], [false, false]);
  // A server from before the tour says nothing, and nothing opens.
  const old = reconcileAccountProfile(account, { user: account.user });
  assert.equal(old.tourDue, undefined);
  assert.equal(old, account, "an unchanged profile reuses the account");
});

test("the role comes back with the profile and shows without changing who the person is", () => {
  const withRole = reconcileAccountProfile(account, { user: { ...account.user, jobRole: { id: "designer", label: "Designer" } }, tour: { due: false } });
  assert.deepEqual(withRole.user, { id: "usr_pat", name: "Pat Tester", role: "member", jobRole: { id: "designer", label: "Designer" } });
  // Cleared on the server: cleared here. The member stays a member either way.
  const cleared = reconcileAccountProfile(withRole, { user: account.user, tour: { due: false } });
  assert.equal(cleared.user.jobRole, undefined);
  assert.equal(cleared.user.role, "member");
  // Something that isn't a role is not shown as one.
  assert.equal(reconcileAccountProfile(account, { user: { ...account.user, jobRole: "owner" as never }, tour: { due: false } }).user.jobRole, undefined);
});

test("Settings has a way back in, and the tour has a way out on every step", () => {
  const you = fs.readFileSync(path.join(import.meta.dirname, "../app/(tabs)/you.tsx"), "utf8");
  assert.match(you, /label="Take the tour"/);
  const screen = fs.readFileSync(path.join(import.meta.dirname, "../app/tour.tsx"), "utf8");
  // One Skip, outside the pages, so it is there whichever page is showing; skipping and finishing both save "seen".
  assert.equal((screen.match(/label="Skip"/g) ?? []).length, 1);
  assert.match(screen, /const leave = [^;]*=> \{\s*markTourSeen\(/);
});
