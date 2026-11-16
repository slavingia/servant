// The org chart in People: who decides whose entitlement requests (docs/entitlements.md), drawn as an indented list.
// Each person carries `managerId`; owners have none and sit at the top.

type Node = { id: string; name: string; managerId?: string | null; owner?: boolean };

const byName = (a: Node, b: Node) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);

/** The people who report straight to this person, A to Z. */
export function reportsOf<T extends Node>(people: readonly T[], id: string): T[] {
  return people.filter(p => p.managerId === id && p.id !== id).sort(byName);
}

/**
 * Everyone once, each manager followed by their reports, with how deep they sit. Owners come first at the top;
 * someone whose manager isn't in the list (or a loop the server should never send) also starts at the top
 * rather than vanishing.
 */
export function orgRows<T extends Node>(people: readonly T[]): { person: T; depth: number; reports: number }[] {
  const ids = new Set(people.map(p => p.id));
  const rows: { person: T; depth: number; reports: number }[] = [];
  const seen = new Set<string>();
  const visit = (person: T, depth: number) => {
    if (seen.has(person.id)) return;
    seen.add(person.id);
    const reports = reportsOf(people, person.id);
    rows.push({ person, depth, reports: reports.length });
    for (const report of reports) visit(report, depth + 1);
  };
  const tops = people.filter(p => !p.managerId || !ids.has(p.managerId) || p.managerId === p.id);
  for (const top of [...tops].sort((a, b) => Number(!!b.owner) - Number(!!a.owner) || byName(a, b))) visit(top, 0);
  for (const left of [...people].sort(byName)) visit(left, 0);
  return rows;
}

/** Everyone under this person, at any depth. */
export function everyoneUnder<T extends Node>(people: readonly T[], id: string): Set<string> {
  const under = new Set<string>();
  const walk = (at: string) => { for (const r of reportsOf(people, at)) if (!under.has(r.id) && r.id !== id) { under.add(r.id); walk(r.id); } };
  walk(id);
  return under;
}

/** Who could be this person's manager: anyone but themselves and the people under them (that would make a loop). */
export function managerChoices<T extends Node>(people: readonly T[], id: string): T[] {
  const under = everyoneUnder(people, id);
  return people.filter(p => p.id !== id && !under.has(p.id)).sort(byName);
}

/** May the viewer change this person's manager? An owner for anyone but owners; otherwise only their current manager. */
export function canChangeManager(person: Node, viewer: { id: string; owner: boolean }): boolean {
  if (person.owner) return false;
  return viewer.owner || (!!person.managerId && person.managerId === viewer.id && person.id !== viewer.id);
}

/** The words beside a name in the chart: "Reports to Ana Ruiz · 2 reports". */
export function orgLine(person: Node, people: readonly Node[], reports: number): string {
  const manager = person.managerId ? people.find(p => p.id === person.managerId) : null;
  return [manager ? `Reports to ${manager.name}` : null, reports ? `${reports} ${reports === 1 ? "report" : "reports"}` : null].filter(Boolean).join(" · ");
}
