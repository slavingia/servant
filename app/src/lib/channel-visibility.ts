// What people need to know about who can read a channel, in words. Used at the top of every channel so a private
// channel never looks like a public one while someone is deciding what to write in it.
export type VisibilityCopy = { label: string; body: string };

export function channelVisibility(isPrivate: boolean, workspace?: string): VisibilityCopy {
  const where = workspace?.trim() || "the workspace";
  return isPrivate
    ? { label: "Private channel", body: "Only people who were added can see this channel and what is said in it." }
    : { label: "Public channel", body: `Anyone in ${where} can find this channel and read it.` };
}

/** The screen-reader name of a channel: its name, plus "private channel" when it is one. */
export function channelA11yName(title: string, isPrivate: boolean): string {
  return isPrivate ? `${title}, private channel` : title;
}
