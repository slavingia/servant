import { useCallback, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import Constants from "expo-constants";
import { nativeBuildVersion } from "expo-application";
import { Button } from "../components/Button";
import { DraftAttachments, pickAttachments, type DraftAttachment } from "../components/Attachments";
import { useSession } from "../lib/session";
import { api, type FeedbackReport } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

const labels: Record<string, string> = { queued: "Queued", working: "Investigating", released: "Fix released", needs_info: "More information needed", reviewed: "Reviewed", interrupted: "Needs retry" };

export default function Feedback() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const { screen, via } = useLocalSearchParams<{ screen?: string; via?: string }>();
  const [text, setText] = useState("");
  const [reports, setReports] = useState<FeedbackReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [shot, setShot] = useState<DraftAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const addScreenshot = async () => {
    if (picking || busy) return;
    setPicking(true); setError("");
    try {
      const picked = (await pickAttachments(true, [])).filter(f => f.mime.startsWith("image/")).slice(0, 1);
      if (picked.length) setShot(picked);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't add the screenshot"); }
    finally { setPicking(false); }
  };
  const requestId = useRef("");
  useFocusEffect(useCallback(() => {
    if (!account) return;
    let active = true;
    const refresh = () => api.feedback(account).then(r => { if (active) setReports(r); }).catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [account]));
  if (!account) return null;
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError("");
    requestId.current ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const report = await api.sendFeedback(account, { text, requestId: requestId.current, context: {
        screen: screen || "/you", platform: Platform.OS, version: Constants.expoConfig?.version || "",
        build: nativeBuildVersion || "development", via: via || "settings",
      }, attachments: shot.map(({ name, data }) => ({ name, data })) });
      setReports(r => [report, ...r.filter(x => x.id !== report.id)]);
      setText(""); setShot([]); setSent(true);
      requestId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't send feedback. Please try again."); }
    finally { setBusy(false); }
  };
  return <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
    <Text style={styles.intro}>Tell us what happened and what you expected. Next time, just shake your phone or take a screenshot on the screen that's wrong.</Text>
    <Text style={styles.label}>Your feedback</Text>
    <TextInput accessibilityLabel="Feedback" placeholder="What should we fix?" value={text}
      onChangeText={value => { setText(value); setSent(false); }} multiline maxLength={4000} autoFocus
      placeholderTextColor={colors.muted} editable={!busy} style={styles.input} textAlignVertical="top" />
    {shot.length
      ? <DraftAttachments files={shot} onRemove={() => setShot([])} disabled={busy} />
      : <Button label={via === "screenshot" ? "Attach the screenshot" : "Add a screenshot"} kind="secondary" busy={picking} disabled={busy} onPress={addScreenshot} />}
    <Text style={styles.caption}>Includes this screen, app build, and platform{shot.length ? ", plus your screenshot" : ""}. Your messages are not attached.</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Button label="Send feedback" busy={busy} disabled={!text.trim()} onPress={send} />
    {sent ? <Text accessibilityLiveRegion="polite" style={styles.body}>Feedback saved. Updates will appear below.</Text> : null}
    <Text accessibilityRole="header" style={styles.sectionHeading}>Your reports</Text>
    {!reports.length ? <Text style={styles.intro}>Your reports and updates will appear here.</Text> : null}
    {reports.map(report => <View key={report.id} style={styles.report}>
      <Text style={styles.status}>{labels[report.status] || report.status}</Text>
      <Text style={styles.body}>{report.text}</Text>
      {report.result ? <Text style={styles.body}>{report.result}</Text> : null}
      {report.status === "interrupted" ? <Pressable accessibilityRole="button" onPress={async () => {
        try { await api.retryFeedback(account, report.id); setReports(await api.feedback(account)); }
        catch { setError("Couldn't retry. Please try again."); }
      }}><Text style={styles.link}>Retry investigation</Text></Pressable> : null}
    </View>)}
  </ScrollView>;
}
const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, gap: space.md, paddingBottom: space.xxl },
  sectionHeading: { ...typography.label, marginTop: space.md, color: colors.ink },
  label: { ...typography.label, color: colors.ink, marginTop: space.xs, marginBottom: -space.xs },
  intro: { ...typography.caption, color: colors.muted },
  body: { ...typography.body, color: colors.ink },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 128 },
  caption: { ...typography.caption, color: colors.muted },
  error: { ...typography.caption, color: colors.red },
  report: { paddingVertical: space.md, gap: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  status: { ...typography.captionStrong, alignSelf: "flex-start", paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: colors.blueSoft, color: colors.blueDark },
  link: { ...typography.bodyStrong, color: colors.blue, paddingVertical: space.sm, minHeight: 44 },
}));
