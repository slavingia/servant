import type { Post } from "./server";

/** Message ids increase on the server; display order and client timestamps can differ. */
export function lastEditableMessage(posts: readonly Post[], me: string): Post | undefined {
  let latest: Post | undefined;
  for (const post of posts) {
    if (post.user.id !== me || post.user.agent || post.deleted || post.pending || post.activity) continue;
    if (!latest || Number(post.id) > Number(latest.id)) latest = post;
  }
  return latest;
}

type EditLastMessageKey = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

type EditLastMessageDraft = {
  text: string;
  attachmentCount: number;
  busy: boolean;
  picking: boolean;
  listening: boolean;
  editing: boolean;
};

/** Only an idle, empty composer may be replaced by the previous message. */
export function shouldEditLastMessage(key: EditLastMessageKey, draft: EditLastMessageDraft): boolean {
  return key.key === "ArrowUp" && !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey &&
    !key.repeat && !key.isComposing && key.keyCode !== 229 && draft.text === "" && draft.attachmentCount === 0 &&
    !draft.busy && !draft.picking && !draft.listening && !draft.editing;
}
