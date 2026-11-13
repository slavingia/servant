// What People shows about a person's work email. Only owners are sent it, and only on servers that check
// email (`emailChecks`), so everyone else sees nothing. An address nobody proved with a code, and a person with no
// address, get a warning mark and say so in words: the mark and its color never carry the meaning alone. The words
// come first so a long address is what gets cut short, not the state.
import type { Person } from "./server";

export type EmailLine = { text: string; unverified: boolean; label: string };

export function emailLine(person: Pick<Person, "email" | "emailVerified">, checked: boolean): EmailLine | null {
  if (!checked) return null;
  if (!person.email) return { text: "No work email", unverified: true, label: "No work email added" };
  if (!person.emailVerified) return { text: `Not verified · ${person.email}`, unverified: true, label: `${person.email}, not verified` };
  return { text: person.email, unverified: false, label: `${person.email}, verified` };
}
