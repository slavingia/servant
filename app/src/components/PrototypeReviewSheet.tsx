import { useCallback, useEffect, useState, useMemo } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "./Button";
import { api, ServerError, type Account, type OutsideReviewer, type PrototypeShare } from "../lib/server";
import { AUTO_WORK_HINT, AUTO_WORK_LABEL, commentAsked, commentWhere, looksLikeEmail, orderShares, outsideReviewerLine, shareLine } from "../lib/prototype-reviews";
import { Toggle } from "./Toggle";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// Share a prototype with a business owner (docs/prototype-reviews.md). The person who built it types a work email;
// the business owner gets a link, confirms a code sent to that address, sees the prototype and right-clicks to
// comment. Each comment becomes a to-do for the person who shared it. This sheet sends links, shows who has opened
// theirs and what they said, and ends a share.
// The same sheet shares a project's app preview (`projectId` instead of `chatId`): its comments become to-dos in
// the project, and nothing there goes to the agent by itself, so it has no switch for that.
export function PrototypeReviewSheet({ account, chatId = "", projectId, title, onClose }: { account: Account; chatId?: string; projectId?: string; title: string; onClose: () => void }) {
  const ofApp = !!projectId;
  const calls = useMemo(() => projectId
    ? { list: () => api.appPreviewShares(account, projectId), share: (to: string) => api.shareAppPreview(account, projectId, to), end: (id: string) => api.endAppPreviewShare(account, projectId, id) }
    : { list: () => api.prototypeShares(account, chatId), share: (to: string) => api.sharePrototype(account, chatId, to), end: (id: string) => api.endPrototypeShare(account, chatId, id) }, [account, chatId, projectId]);
  const styles = useStyles();
  const { colors } = useTheme();
  const [shares, setShares] = useState<PrototypeShare[] | null>(null);
  // The project's outside reviewers who have no link to this prototype yet: one press each, no retyping.
  const [suggested, setSuggested] = useState<OutsideReviewer[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const failed = (e: unknown, fallback: string) => e instanceof ServerError ? e.message : fallback;
  const load = useCallback(() => {
    calls.list().then(r => { setShares(r.shares); setSuggested(r.suggested ?? []); }, e => { setShares([]); setError(failed(e, "Couldn't load who this is shared with. Close and try again")); });
  }, [calls]);
  useEffect(load, [load]);

  const send = async () => {
    const to = email.trim();
    if (busy) return;
    if (!looksLikeEmail(to)) { setError(ofApp ? "Enter the reviewer's work email" : "Enter the business owner's work email"); return; }
    setBusy("send"); setError(null); setSent(null);
    try {
      const next = await calls.share(to);
      setShares(next.shares); setSuggested(next.suggested ?? []);
      setSent(to); setEmail("");
    } catch (e) { setError(failed(e, "Couldn't send the link. Try again")); }
    finally { setBusy(null); }
  };
  // Send to the project's reviewers: one of them, or everyone still on the list, one after another.
  const sendTo = async (people: OutsideReviewer[], key: string) => {
    if (busy || !people.length) return;
    setBusy(key); setError(null); setSent(null);
    const done: string[] = [];
    try {
      for (const person of people) {
        const next = await calls.share(person.email);
        setShares(next.shares); setSuggested(next.suggested ?? []);
        done.push(person.email);
      }
    } catch (e) { setError(failed(e, "Couldn't send the link. Try again")); }
    finally { if (done.length) setSent(done.join(", ")); setBusy(null); }
  };
  const end = async (share: PrototypeShare) => {
    if (busy) return;
    setBusy(share.id); setError(null); setSent(null);
    try { const next = await calls.end(share.id); setShares(next.shares); setSuggested(next.suggested ?? []); }
    catch (e) { setError(failed(e, "Couldn't end that share. Try again")); }
    finally { setBusy(null); }
  };

  const setAuto = async (share: PrototypeShare, on: boolean) => {
    if (busy) return;
    setBusy(`auto:${share.id}`); setError(null); setSent(null);
    try { setShares((await api.setPrototypeShareAutoWork(account, chatId, share.id, on)).shares); }
    catch (e) { setError(failed(e, "Couldn't change that. Try again")); }
    finally { setBusy(null); }
  };

  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.scrim}>
      <View testID="prototype-review-sheet" accessibilityViewIsModal style={styles.dialog}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>{ofApp ? "Share with a reviewer" : "Share with a business owner"}</Text>
          <Text style={styles.body}>{ofApp
            ? `They get a link to "${title}" by email. After confirming a code sent to that address, they can use the app in their browser, with its sample data, and right-click anywhere on it to leave a comment. Each comment comes back to this screen, for you to decide what to do with.`
            : `They get a link to "${title}" by email. After confirming a code sent to that address, they can look at the prototype and right-click anywhere on it to leave a comment. Each comment comes to this chat, for you to decide what to do with.`}</Text>
          <Text style={styles.label}>Their work email</Text>
          <TextInput testID="review-email" accessibilityLabel="Their work email" value={email} onChangeText={value => { setEmail(value); setError(null); }} editable={busy !== "send"}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254} onSubmitEditing={() => void send()} returnKeyType="send"
            placeholder="name@example.gov" placeholderTextColor={colors.muted} style={styles.input} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {sent ? <Text testID="review-sent" accessibilityLiveRegion="polite" style={styles.sent}>{`Sent to ${sent}.`}</Text> : null}
          <Button testID="review-send" label="Send link" busy={busy === "send"} onPress={() => void send()} />
          {suggested.length ? <View testID="review-suggested">
            <Text accessibilityRole="header" style={styles.section}>This project&apos;s reviewers</Text>
            <View style={styles.list}>
              {suggested.map(person => <View key={person.email} style={[styles.row, styles.rowHead]}>
                <View style={styles.rowCopy}><Text style={styles.name}>{outsideReviewerLine(person)}</Text></View>
                <Button testID={`review-suggest-${person.email}`} label="Send" accessibilityLabel={`Send the link to ${person.email}`} kind="secondary" compact busy={busy === `to:${person.email}`} disabled={!!busy} onPress={() => void sendTo([person], `to:${person.email}`)} />
              </View>)}
            </View>
            {suggested.length > 1 ? <Button testID="review-suggest-all" label={`Send to all ${suggested.length}`} kind="secondary" busy={busy === "all"} disabled={!!busy} onPress={() => void sendTo(suggested, "all")} style={styles.all} /> : null}
          </View> : null}

          {shares === null ? <ActivityIndicator color={colors.blue} style={styles.spinner} /> : null}
          {shares && shares.length ? <View>
            <Text accessibilityRole="header" style={styles.section}>Shared with</Text>
            <View style={styles.list}>
              {orderShares(shares).map(share => <View key={share.id} testID={`review-share-${share.id}`} style={styles.row}>
                <View style={styles.rowHead}>
                  <View style={styles.rowCopy}>
                    <Text style={styles.name}>{share.email}</Text>
                    <Text style={styles.meta}>{shareLine(share)}</Text>
                  </View>
                  {share.endedAt ? null : <Button testID={`review-end-${share.id}`} label="End" accessibilityLabel={`End sharing with ${share.email}`} kind="danger" compact busy={busy === share.id} disabled={!!busy} onPress={() => void end(share)} />}
                </View>
                {/* For someone you trust to steer the work: their comments go straight to Agent. Off unless you say so. */}
                {share.endedAt || ofApp ? null : <View style={styles.auto}>
                  <View style={styles.rowCopy}>
                    <Text style={styles.autoLabel}>{AUTO_WORK_LABEL}</Text>
                    <Text style={styles.meta}>{AUTO_WORK_HINT}</Text>
                  </View>
                  <Toggle testID={`review-auto-${share.id}`} label={`${AUTO_WORK_LABEL}, for ${share.email}`} value={!!share.autoWork} disabled={!!busy} onValueChange={on => void setAuto(share, on)} />
                </View>}
                {share.comments.map(comment => <View key={comment.id} style={styles.comment}>
                  <Text style={styles.body}>{comment.text}</Text>
                  <Text style={styles.meta}>{[commentWhere(comment), commentAsked(comment)].filter(Boolean).join(" · ")}</Text>
                </View>)}
              </View>)}
            </View>
          </View> : null}
          <Button testID="review-done" label="Done" kind="secondary" onPress={onClose} />
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: colors.scrim },
  dialog: { width: "100%", maxWidth: 480, maxHeight: "100%", backgroundColor: colors.background, borderRadius: radius.lg, overflow: "hidden" },
  content: { padding: space.lg, gap: space.sm },
  title: { ...typography.heading, color: colors.ink },
  body: { ...typography.body, color: colors.ink },
  label: { ...typography.label, color: colors.muted },
  input: controls.input,
  error: { ...typography.caption, color: colors.red },
  sent: { ...typography.caption, color: colors.muted },
  spinner: { marginVertical: space.md },
  section: { ...typography.label, color: colors.muted, marginTop: space.md, marginBottom: space.xs },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  row: { paddingVertical: space.sm, gap: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowCopy: { flex: 1, minWidth: 0 },
  name: { ...typography.bodyStrong, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted },
  all: { marginTop: space.sm },
  auto: { flexDirection: "row", alignItems: "center", gap: space.sm },
  autoLabel: { ...typography.label, color: colors.ink },
  comment: { paddingLeft: space.sm, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line, gap: space.xxs },
}));
