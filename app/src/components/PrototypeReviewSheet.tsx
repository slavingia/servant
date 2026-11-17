import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "./Button";
import { api, ServerError, type Account, type PrototypeShare } from "../lib/server";
import { commentWhere, looksLikeEmail, orderShares, shareLine } from "../lib/prototype-reviews";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// Share a prototype with a business owner (docs/prototype-reviews.md). The person who built it types a work email;
// the business owner gets a link, confirms a code sent to that address, sees the prototype and right-clicks to
// comment. Each comment becomes a to-do for the person who shared it. This sheet sends links, shows who has opened
// theirs and what they said, and ends a share.
export function PrototypeReviewSheet({ account, chatId, title, onClose }: { account: Account; chatId: string; title: string; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [shares, setShares] = useState<PrototypeShare[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const failed = (e: unknown, fallback: string) => e instanceof ServerError ? e.message : fallback;
  const load = useCallback(() => {
    api.prototypeShares(account, chatId).then(r => setShares(r.shares), e => { setShares([]); setError(failed(e, "Couldn't load who this is shared with. Close and try again")); });
  }, [account, chatId]);
  useEffect(load, [load]);

  const send = async () => {
    const to = email.trim();
    if (busy) return;
    if (!looksLikeEmail(to)) { setError("Enter the business owner's work email"); return; }
    setBusy("send"); setError(null); setSent(null);
    try {
      setShares((await api.sharePrototype(account, chatId, to)).shares);
      setSent(to); setEmail("");
    } catch (e) { setError(failed(e, "Couldn't send the link. Try again")); }
    finally { setBusy(null); }
  };
  const end = async (share: PrototypeShare) => {
    if (busy) return;
    setBusy(share.id); setError(null); setSent(null);
    try { setShares((await api.endPrototypeShare(account, chatId, share.id)).shares); }
    catch (e) { setError(failed(e, "Couldn't end that share. Try again")); }
    finally { setBusy(null); }
  };

  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.scrim}>
      <View testID="prototype-review-sheet" accessibilityViewIsModal style={styles.dialog}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>Share with a business owner</Text>
          <Text style={styles.body}>{`They get a link to "${title}" by email. After confirming a code sent to that address, they can look at the prototype and right-click anywhere on it to leave a comment. Each comment becomes a to-do for you.`}</Text>
          <Text style={styles.label}>Their work email</Text>
          <TextInput testID="review-email" accessibilityLabel="Their work email" value={email} onChangeText={value => { setEmail(value); setError(null); }} editable={busy !== "send"}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254} onSubmitEditing={() => void send()} returnKeyType="send"
            placeholder="name@example.gov" placeholderTextColor={colors.muted} style={styles.input} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {sent ? <Text testID="review-sent" accessibilityLiveRegion="polite" style={styles.sent}>{`Sent to ${sent}.`}</Text> : null}
          <Button testID="review-send" label="Send link" busy={busy === "send"} onPress={() => void send()} />

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
                {share.comments.map(comment => <View key={comment.id} style={styles.comment}>
                  <Text style={styles.body}>{comment.text}</Text>
                  <Text style={styles.meta}>{commentWhere(comment)}</Text>
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
  comment: { paddingLeft: space.sm, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line, gap: space.xxs },
}));
