// Best guess at a person's name from their work email, for them to fix:
// pat.tester@irs.gov -> "Pat Tester"; jlee@irs.gov -> "Jlee"; pat.tester2@ -> "Pat Tester".
export function nameFromEmail(email: string): string {
  const local = String(email || "").split("@")[0].split("+")[0];
  const words = local.split(/[._\-\s]+/).map((w) => w.replace(/\d+/g, "")).filter(Boolean).slice(0, 3);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ").slice(0, 80);
}
