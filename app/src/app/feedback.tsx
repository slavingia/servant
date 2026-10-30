import { useCallback, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import Constants from "expo-constants";
import { useSession } from "../lib/session";
import { api, type FeedbackReport } from "../lib/server";
import { colors } from "../lib/theme";

const labels: Record<string, string> = { queued: "Queued", working: "Investigating", released: "Fix released", needs_info: "More information needed", reviewed: "Reviewed", interrupted: "Needs retry" };

export default function Feedback() {
  const { account } = useSession();
  const { screen } = useLocalSearchParams<{ screen?: string }>();
  const [text, setText] = useState("");
  const [reports, setReports] = useState<FeedbackReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
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
        build: Constants.nativeBuildVersion || "development",
      } });
      setReports(r => [report, ...r.filter(x => x.id !== report.id)]);
      setText(""); setSent(true);
      requestId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't send feedback. Please try again."); }
    finally { setBusy(false); }
  };
  return <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
    <Text style={styles.heading}>Send feedback to Servant</Text>
    <Text style={styles.body}>Describe what went wrong and what you expected. The development agent will investigate, fix verified issues, and ship a new build.</Text>
    <TextInput accessibilityLabel="Feedback" placeholder="What should we fix?" value={text}
      onChangeText={value => { setText(value); setSent(false); }} multiline maxLength={4000} autoFocus
      editable={!busy} style={styles.input} textAlignVertical="top" />
    <Text style={styles.caption}>Includes this screen, app build, and platform. Messages and screenshots are not attached.</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={busy || !text.trim()} onPress={send}
      style={[styles.button, (busy || !text.trim()) && { opacity: 0.5 }]}>
      <Text style={styles.buttonText}>{busy ? "Sending…" : "Send feedback"}</Text>
    </Pressable>
    {sent ? <Text accessibilityLiveRegion="polite" style={styles.body}>Feedback saved. You can close this screen while the agent works.</Text> : null}
    <Text style={styles.heading}>Your reports</Text>
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
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white }, content: { padding: 20, gap: 16, paddingBottom: 80 },
  heading: { fontSize: 22, fontWeight: "700", color: colors.ink }, body: { fontSize: 16, lineHeight: 23, color: colors.ink },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 14, minHeight: 130, fontSize: 17, color: colors.ink },
  caption: { fontSize: 13, color: colors.muted }, error: { color: colors.red },
  button: { backgroundColor: colors.blue, borderRadius: 10, padding: 15, alignItems: "center" }, buttonText: { color: colors.white, fontSize: 17, fontWeight: "600" },
  report: { padding: 16, gap: 8, borderRadius: 10, backgroundColor: colors.surface }, status: { fontWeight: "700", color: colors.ink }, link: { color: colors.blue, paddingVertical: 12 },
});
