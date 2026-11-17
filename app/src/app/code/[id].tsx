import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../../components/Button";
import { cleanCode, shouldAutoSend } from "../../lib/code-autosend";
import { api, ServerError, type CodeRequest } from "../../lib/server";
import { useSession } from "../../lib/session";
import { createThemedStyles, space, typography, useTheme } from "../../lib/theme";

// An automation signed in as you (server: code-requests.mjs) reached a "enter the code we sent you" step. You type the
// code here; that automation picks it up once. The code is never shown back, kept on this phone or put in a push.
// A complete code sends itself, so a code iOS fills in from Messages needs no tap (lib/code-autosend.ts).
export default function EnterCode() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { account } = useSession();
  const styles = useStyles();
  const { colors } = useTheme();
  const [request, setRequest] = useState<CodeRequest | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"sent" | "cancelled" | null>(null);
  const [minutes, setMinutes] = useState(0);
  const inFlight = useRef(false);
  const lastSent = useRef<string | null>(null);
  const field = useRef<{ focus(): void } | null>(null);
  // The box is ready to type in: when the request loads (autoFocus can miss right after the screen slides in), and
  // again when the app or the Mac window comes back to the front while it waits.
  const waiting = request?.status === "pending" && !done;
  useEffect(() => {
    if (!waiting) return;
    const focus = () => field.current?.focus();
    const timer = setTimeout(focus, 350);
    const state = AppState.addEventListener("change", s => { if (s === "active") setTimeout(focus, 100); });
    const onWindow = () => setTimeout(focus, 50);
    if (Platform.OS === "web" && typeof window !== "undefined") window.addEventListener("focus", onWindow);
    return () => { clearTimeout(timer); state.remove(); if (Platform.OS === "web" && typeof window !== "undefined") window.removeEventListener("focus", onWindow); };
  }, [waiting]);

  useEffect(() => {
    if (!account || !id) return;
    let live = true;
    api.codeRequest(account, id).then(r => { if (live) { setRequest(r.request); setMinutes(Math.max(1, Math.round((r.request.expiresAt - Date.now()) / 60000))); } })
      .catch(e => { if (live) setError(e instanceof ServerError && e.message ? e.message : "Couldn't load this code request. Check your connection and try again."); });
    return () => { live = false; };
  }, [account, id]);

  const cleaned = cleanCode(code);
  const ready = /^[A-Za-z0-9]{4,12}$/.test(cleaned);
  const act = async (send: boolean, value = cleaned) => {
    if (!account || !request || inFlight.current || (send && !/^[A-Za-z0-9]{4,12}$/.test(value))) return;
    inFlight.current = true; setBusy(true); setError(null);
    if (send) lastSent.current = value;
    try {
      if (send) await api.answerCodeRequest(account, request.id, value);
      else await api.cancelCodeRequest(account, request.id);
      setCode(""); setDone(send ? "sent" : "cancelled");
    } catch (e) {
      setError(e instanceof ServerError && e.message ? e.message : "Couldn't send the code. Check your connection and try again.");
    } finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {done ? <>
          <Text accessibilityRole="header" style={styles.title}>{done === "sent" ? "Code sent" : "Request cancelled"}</Text>
          <Text style={styles.lead}>{done === "sent" ? `${request?.device || "The automation"} can continue now. The code isn't kept here.` : "Nothing was sent."}</Text>
          <Button label="Done" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} style={styles.action} />
        </> : !request ? (error ? <>
          <Text accessibilityRole="header" style={styles.title}>Enter code</Text>
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
          <Button label="Back to Servant" onPress={() => router.replace("/")} style={styles.action} />
        </> : <ActivityIndicator accessibilityLabel="Loading code request" color={colors.blue} size="large" style={styles.action} />) : request.status !== "pending" ? <>
          <Text accessibilityRole="header" style={styles.title}>{request.label}</Text>
          <Text style={styles.lead}>{request.status === "expired" ? "This request expired. Start the sign-in again to get a new one." : "This request is already finished."}</Text>
          <Button label="Back to Servant" onPress={() => router.replace("/")} style={styles.action} />
        </> : <>
          <Text accessibilityRole="header" style={styles.title}>{request.label}</Text>
          <Text style={styles.lead}>{request.device} is waiting for this code.</Text>
          {request.hint ? <Text style={styles.keep}>{request.hint}</Text> : null}
          <Text style={styles.label} nativeID="codeRequestLabel">Code</Text>
          <TextInput
            testID="code-request-code"
            ref={(node: unknown) => { field.current = node as { focus(): void } | null; }}
            accessibilityLabelledBy="codeRequestLabel"
            accessibilityLabel="Code"
            value={code}
            onChangeText={t => {
              setCode(t); setError(null);
              if (request?.status === "pending" && shouldAutoSend(t, request.length, lastSent.current)) void act(true, cleanCode(t));
            }}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            inputMode="numeric"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={16}
            returnKeyType="send"
            onSubmitEditing={() => void act(true)}
            editable={!busy}
            style={[styles.input, styles.codeInput, error && styles.inputError]}
          />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Button label="Send code" onPress={() => void act(true)} busy={busy} disabled={!ready} style={styles.action} />
          <Text style={styles.note}>{request.length ? `Sends by itself once all ${request.length} characters are in.` : "A six-digit code sends by itself once it's complete."}</Text>
          <View style={styles.row}>
            <Button label="Cancel request" kind="secondary" onPress={() => void act(false)} disabled={busy} style={styles.half} />
          </View>
          <Text style={styles.note}>Only send a code for something you started. Expires in {minutes} {minutes === 1 ? "minute" : "minutes"}.</Text>
        </>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 520, alignSelf: "center" },
  title: { ...typography.title, color: colors.ink },
  lead: { ...typography.body, color: colors.ink, marginTop: space.xs },
  keep: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  label: { ...typography.label, marginTop: space.xl, color: colors.ink },
  input: { ...controls.input, marginTop: space.xs },
  codeInput: { fontSize: typography.title.fontSize, lineHeight: typography.title.lineHeight, letterSpacing: 6, fontVariant: ["tabular-nums"], minHeight: 56 },
  inputError: { borderColor: colors.red },
  error: { ...typography.caption, marginTop: space.xs, color: colors.red },
  action: { marginTop: space.md },
  row: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  half: { flex: 1 },
  note: { ...typography.caption, color: colors.muted, marginTop: space.sm },
}));
