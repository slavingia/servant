import { useEffect, useRef, useState } from "react";
import { Linking, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button, ButtonGroup } from "./Button";
import { Avatar } from "./Messaging";
import { Radio } from "./Radio";
import type { Account } from "../lib/server";
import { agoLabel, lengthLine, NEEDS_ENTITLEMENT, parseWhen, replyLine, sourceLine, whenChoices, type SocialPost, type SocialReply } from "../lib/social";
import { socialApi } from "../lib/social-api";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const said = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

// One post from X and what the team will say back. Almost every card ends one of three ways: Agent drafts a reply
// and someone approves it, someone writes the reply themselves, or the post is skipped. The draft is edited in
// place; Approve saves what is in the box first, so reading, fixing and approving is one pass down the list.
export function SocialPostCard({ account, post, canApprove, limit, onChange }: {
  account: Account; post: SocialPost; canApprove: boolean; limit: number;
  /** The post after something changed. The list decides whether it still belongs there. */
  onChange: (post: SocialPost) => void;
}) {
  const styles = useStyles();
  const [busy, setBusy] = useState<"draft" | "skip" | "restore" | "write" | null>(null);
  const [error, setError] = useState("");
  // Writing the reply by hand, before there is one to edit.
  const [writing, setWriting] = useState(false);
  const [own, setOwn] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = async (what: NonNullable<typeof busy>, work: () => Promise<{ post: SocialPost }>, failed: string) => {
    if (busy) return;
    setBusy(what); setError("");
    try {
      const next = await work();
      if (mounted.current) { setWriting(false); setOwn(""); onChange(next.post); }
    } catch (reason) {
      if (mounted.current) setError(said(reason, failed));
    } finally { if (mounted.current) setBusy(null); }
  };
  const reply = post.reply ?? null;
  const who = `${post.author.name}${post.author.handle ? ` @${post.author.handle}` : ""}`;
  const count = lengthLine(own, limit);
  return <View testID={`social-post-${post.id}`} style={styles.card}>
    <View style={styles.head}>
      <Avatar name={post.author.name} size={36} />
      <View style={styles.headCopy}>
        <Text style={styles.name}>{post.author.name}{post.author.handle ? <Text style={styles.handle}>{`  @${post.author.handle}`}</Text> : null}</Text>
        <Text style={styles.meta}>{`${sourceLine(post)} · ${agoLabel(post.postedAt)}`}</Text>
      </View>
    </View>
    <Text selectable style={styles.text}>{post.text}</Text>
    <View style={styles.row}><Button label="Open on X" accessibilityLabel={`Open ${who}'s post on X`} kind="link" compact icon="external" onPress={() => void Linking.openURL(post.url)} /></View>

    {post.skipped
      ? <View style={styles.reply}>
          <Text style={styles.meta}>{`Skipped${post.skipped.byName ? ` by ${post.skipped.byName}` : ""}`}</Text>
          <ButtonGroup><Button testID={`social-restore-${post.id}`} label="Bring back" accessibilityLabel={`Bring back ${who}'s post`} kind="secondary" compact busy={busy === "restore"} onPress={() => void run("restore", () => socialApi.restore(account, post.id), "Couldn't bring this post back. Try again.")} /></ButtonGroup>
        </View>
      : reply
        ? <View style={styles.reply}>
            <SocialReplyEditor key={reply.id} account={account} reply={reply} to={who} canApprove={canApprove} limit={limit}
              onReply={next => onChange({ ...post, reply: next })}
              onRedraft={async instruction => onChange((await socialApi.draft(account, post.id, instruction)).post)} />
          </View>
        : <View style={styles.reply}>
            {post.suggestion ? <Text testID={`social-suggestion-${post.id}`} style={styles.advice}>{`Agent advises not replying: ${post.suggestion}`}</Text> : null}
            {writing ? <>
              <TextInput testID={`social-own-${post.id}`} accessibilityLabel={`Your reply to ${who}`} placeholder="Write the reply" value={own} onChangeText={setOwn} multiline autoFocus editable={!busy} style={styles.input} />
              <Text style={[styles.meta, count.over && styles.over]}>{count.text}</Text>
            </> : null}
            <ButtonGroup>
              {writing
                ? <>
                    <Button testID={`social-save-own-${post.id}`} label="Save reply" compact busy={busy === "write"} disabled={!own.trim() || count.over} onPress={() => void run("write", () => socialApi.write(account, post.id, own), "Couldn't save your reply. Try again.")} />
                    <Button label="Cancel" kind="link" compact disabled={!!busy} onPress={() => { setWriting(false); setOwn(""); setError(""); }} />
                  </>
                : <>
                    <Button testID={`social-draft-${post.id}`} label="Draft reply" accessibilityLabel={`Ask Agent to draft a reply to ${who}`} kind={post.suggestion ? "secondary" : "primary"} compact busy={busy === "draft"} disabled={!!busy}
                      onPress={() => void run("draft", () => socialApi.draft(account, post.id), "Agent couldn't draft a reply. Try again, or write it yourself.")} />
                    <Button testID={`social-write-${post.id}`} label="Write reply" accessibilityLabel={`Write a reply to ${who} yourself`} kind="secondary" compact disabled={!!busy} onPress={() => setWriting(true)} />
                    <Button testID={`social-skip-${post.id}`} label="Skip" accessibilityLabel={`Skip ${who}'s post`} kind={post.suggestion ? "primary" : "secondary"} compact busy={busy === "skip"} disabled={!!busy}
                      onPress={() => void run("skip", () => socialApi.skip(account, post.id), "Couldn't skip this post. Try again.")} />
                  </>}
            </ButtonGroup>
            {busy === "draft" ? <Text style={styles.meta}>Agent is writing. This can take a moment.</Text> : null}
          </View>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

// A reply that is not approved yet: its words in a box anyone can change, and what can be done with it. What is in
// the box is saved when the box is left and before anything else happens to the reply, so there is no Save button
// to forget. Used for replies to posts and for the team's own posts.
export function SocialReplyEditor({ account, reply, to, canApprove, limit, onReply, onRedraft }: {
  account: Account; reply: SocialReply;
  /** Who the reply is to, for labels. Absent for a post of the team's own. */
  to?: string;
  canApprove: boolean; limit: number;
  /** The reply after a change; null when it was discarded. */
  onReply: (reply: SocialReply | null) => void;
  /** Ask Agent for another draft, with what to change. Only for replies. */
  onRedraft?: (instruction: string) => Promise<void>;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [text, setText] = useState(reply.text);
  const [busy, setBusy] = useState<"approve" | "discard" | "redraft" | null>(null);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState("");
  // The words as the server last had them. When they change underneath (someone else edited, or Agent redrafted),
  // the box shows the new ones unless this person is in the middle of changing it.
  const [saved, setSaved] = useState(reply.text);
  if (reply.text !== saved) { setSaved(reply.text); if (text.trim() === saved) setText(reply.text); }
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const count = lengthLine(text, limit);
  const dirty = text.trim() !== saved;
  const label = to ? `Reply to ${to}` : "Post";
  // Leaving the box saves it, and the press that took the pointer out of the box (Approve, usually) must not be
  // lost to that save: it waits for it instead. Saving the same words twice changes nothing on the server.
  const leaving = useRef<Promise<unknown> | null>(null);
  /** Save what is in the box if it changed; resolves to the reply as the server has it. */
  const keep = async (): Promise<SocialReply> => {
    await leaving.current?.catch(() => {});
    if (!dirty) return reply;
    const next = (await socialApi.edit(account, reply.id, text)).reply;
    if (mounted.current) setSaved(next.text);
    return next;
  };
  const run = async (what: NonNullable<typeof busy>, work: () => Promise<void>, failed: string) => {
    if (busy) return;
    setBusy(what); setError("");
    try { await work(); } catch (reason) { if (mounted.current) setError(said(reason, failed)); } finally { if (mounted.current) setBusy(null); }
  };
  const save = () => {
    if (!dirty || !text.trim() || count.over || busy) return;
    const saving = keep().then(next => { if (mounted.current) { setError(""); onReply(next); } }, reason => { if (mounted.current) setError(said(reason, "Couldn't save your changes. Try again.")); });
    leaving.current = saving;
    void saving.finally(() => { if (leaving.current === saving) leaving.current = null; });
  };
  const approve = (at?: number) => run("approve", async () => {
    const kept = await keep();
    const approved = (await socialApi.approve(account, kept.id, at)).reply;
    if (mounted.current) setChoosing(false);
    onReply(approved);
  }, "Couldn't approve this. Try again.");

  return <View testID={`social-reply-${reply.id}`} style={styles.editor}>
    <Text style={[styles.meta, (reply.status === "failed" || !!reply.error) && styles.over]}>{replyLine(reply)}</Text>
    <TextInput testID={`social-text-${reply.id}`} accessibilityLabel={label} value={text} onChangeText={setText} onBlur={save} multiline editable={busy !== "approve" && busy !== "discard" && busy !== "redraft"}
      placeholderTextColor={colors.muted} style={styles.input} />
    <Text testID={`social-count-${reply.id}`} style={[styles.meta, count.over && styles.over]}>{count.over ? `${count.text}. Shorten it before it can be approved.` : count.text}</Text>
    {asking && onRedraft ? <View style={styles.askRow}>
      <TextInput testID={`social-instruction-${reply.id}`} accessibilityLabel="What Agent should change" placeholder="What should change? For example: shorter, or mention the help page" placeholderTextColor={colors.muted}
        value={instruction} onChangeText={setInstruction} maxLength={500} editable={!busy} autoFocus style={styles.ask} />
      <ButtonGroup>
        <Button testID={`social-redraft-go-${reply.id}`} label="Ask Agent" compact busy={busy === "redraft"} onPress={() => void run("redraft", async () => { await keep(); await onRedraft(instruction.trim()); if (mounted.current) { setInstruction(""); setAsking(false); } }, "Agent couldn't redraft this. Try again.")} />
        <Button label="Cancel" kind="link" compact disabled={!!busy} onPress={() => { setAsking(false); setInstruction(""); }} />
      </ButtonGroup>
    </View> : null}
    {asking ? null : <ButtonGroup>
      {canApprove ? <>
        <Button testID={`social-approve-${reply.id}`} label="Approve" accessibilityLabel={`Approve: ${label}`} compact busy={busy === "approve"} disabled={!!busy || !text.trim() || count.over} onPress={() => void approve()} />
        <Button testID={`social-when-${reply.id}`} label="Choose a time" accessibilityLabel={`Choose when to post: ${label}`} kind="secondary" compact disabled={!!busy || !text.trim() || count.over} onPress={() => { setError(""); setChoosing(true); }} />
      </> : null}
      {onRedraft ? <Button testID={`social-redraft-${reply.id}`} label="Redraft" accessibilityLabel={`Ask Agent to redraft: ${label}`} kind="secondary" compact disabled={!!busy} onPress={() => setAsking(true)} /> : null}
      <Button testID={`social-discard-${reply.id}`} label="Discard" accessibilityLabel={`Discard: ${label}`} kind="danger" compact busy={busy === "discard"} disabled={!!busy}
        onPress={() => void run("discard", async () => { await socialApi.discard(account, reply.id); onReply(null); }, "Couldn't discard this. Try again.")} />
    </ButtonGroup>}
    {canApprove ? null : <View style={styles.needs}>
      <Text style={styles.meta}>{`Waiting for someone to approve it. ${NEEDS_ENTITLEMENT}`}</Text>
      <Button label="Ask for Social media" kind="link" compact onPress={() => router.push("/entitlements")} />
    </View>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {choosing ? <WhenDialog label={label} busy={busy === "approve"} error={error} onCancel={() => { setChoosing(false); setError(""); }} onChoose={at => void approve(at ?? undefined)} /> : null}
  </View>;
}

// When an approved reply goes out: the next opening (the server keeps replies a few minutes apart), one of two
// quick times, or a date and time typed in.
function WhenDialog({ label, busy, error, onChoose, onCancel }: { label: string; busy: boolean; error: string; onChoose: (at: number | null) => void; onCancel: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [choices] = useState(() => whenChoices());
  const [chosen, setChosen] = useState("next");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [problem, setProblem] = useState("");
  const confirm = () => {
    setProblem("");
    if (chosen !== "custom") return onChoose(choices.find(choice => choice.id === chosen)?.at ?? null);
    const when = parseWhen(date, time);
    if ("error" in when) return setProblem(when.error);
    onChoose(when.at);
  };
  return <Modal visible transparent animationType="fade" onRequestClose={() => { if (!busy) onCancel(); }}>
    <View style={styles.scrim}>
      <View style={styles.dialog} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.dialogContent} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={styles.dialogTitle}>When should this go out?</Text>
          <Text style={styles.meta}>{label}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="When to post">
            {[...choices.map(choice => ({ id: choice.id, label: choice.label })), { id: "custom", label: "A date and time" }].map(choice =>
              <Radio key={choice.id} testID={`social-when-${choice.id}`} accessibilityLabel={choice.label} accessibilityState={{ checked: chosen === choice.id, disabled: busy }} aria-checked={chosen === choice.id} disabled={busy} onPress={() => { setChosen(choice.id); setProblem(""); }} style={styles.choice}>
                <View style={[styles.dot, chosen === choice.id && styles.dotOn]}>{chosen === choice.id ? <View style={styles.dotFill} /> : null}</View>
                <Text style={styles.choiceText}>{choice.label}</Text>
              </Radio>)}
          </View>
          {chosen === "custom" ? <View style={styles.custom}>
            <TextInput testID="social-when-date" accessibilityLabel="Date" placeholder="Date, like 11/21" placeholderTextColor={colors.muted} value={date} onChangeText={setDate} editable={!busy} autoCapitalize="none" style={styles.field} />
            <TextInput testID="social-when-time" accessibilityLabel="Time" placeholder="Time, like 9:30 AM" placeholderTextColor={colors.muted} value={time} onChangeText={setTime} editable={!busy} autoCapitalize="none" style={styles.field} />
          </View> : null}
          {problem || error ? <Text accessibilityRole="alert" style={styles.error}>{problem || error}</Text> : null}
          <ButtonGroup align="end">
            <Button label="Cancel" kind="secondary" disabled={busy} onPress={onCancel} />
            <Button testID="social-when-confirm" label="Approve" busy={busy} onPress={confirm} />
          </ButtonGroup>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  card: { paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, gap: space.xs },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  headCopy: { flex: 1, minWidth: 0 },
  name: { ...typography.bodyStrong, color: colors.ink },
  handle: { ...typography.body, color: colors.muted },
  meta: { ...typography.caption, color: colors.muted },
  text: { ...typography.body, color: colors.ink },
  row: { flexDirection: "row" },
  reply: { gap: space.xs, paddingLeft: space.md, borderLeftWidth: 2, borderLeftColor: colors.line },
  advice: { ...typography.bodyStrong, color: colors.ink },
  editor: { gap: space.xs },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 88 },
  askRow: { gap: space.xs },
  ask: controls.input,
  needs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.xs },
  over: { color: colors.red },
  error: { ...typography.caption, color: colors.red },
  scrim: { flex: 1, backgroundColor: colors.scrim, alignItems: "center", justifyContent: "center", padding: space.md },
  dialog: { width: "100%", maxWidth: 440, maxHeight: "90%", borderRadius: radius.lg, backgroundColor: colors.background },
  dialogContent: { padding: space.lg, gap: space.sm },
  dialogTitle: { ...typography.heading, color: colors.ink },
  choice: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
  choiceText: { ...typography.body, color: colors.ink, flex: 1 },
  dot: { width: 20, height: 20, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  dotOn: { borderColor: colors.primary },
  dotFill: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.primary },
  custom: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  field: { ...controls.input, flexGrow: 1, flexBasis: 160 },
}));
