import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { ServerSwitcher } from "../components/ServerSwitcher";
import { Button } from "../components/Button";
import { accountId, api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { clearSessionExpired, noteSessionInfo, sessionInfoNow } from "../lib/session-expiry";
import { canResend, cleanCode, expiryLead } from "../lib/session-expiry-rules";
import { emailConfirmed } from "../lib/email-nudge";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";

// "Confirm it's you": the one screen for a session that ended (server: session-expiry.mjs).
// A code goes to the work email already on the account; the same device continues with
// everything intact. People with no email on file add one here instead, which is the same
// proof. No countdowns, no sign-out: the account on this device is never touched.
type Step = "sending" | "code" | "email" | "emailCode" | "failed" | "done";

export default function Reverify() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account, accounts, signOut } = useSession();
  const [step, setStep] = useState<Step>("sending");
  const [maskedEmail, setMaskedEmail] = useState<string | null>(sessionInfoNow()?.email ?? null);
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [resendReady, setResendReady] = useState(false);
  const submitted = useRef("");
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const maxHours = sessionInfoNow()?.maxHours ?? null;

  const say = (e: unknown, fallback: string) => setError(e instanceof ServerError && e.message ? e.message : fallback);

  // Ask for the code as soon as the screen opens; the person only has to read their mail.
  const sendCode = useCallback(async (again = false) => {
    if (!account) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const out = await api.sessionEmail(account);
      setChallenge(out.challenge); setMaskedEmail(out.email); setCode(""); submitted.current = "";
      setLastSentAt(Date.now()); setResendReady(false);
      setStep("code");
      if (again) setNotice(`We sent a new code to ${out.email}.`);
    } catch (e) {
      if (e instanceof ServerError && e.code === "email_needed") { setStep("email"); return; }
      if (e instanceof ServerError && e.code === "rate_limited" && again) { setNotice(null); setError(e.message); return; }
      say(e, "Couldn't send the code. Check your connection and try again.");
      if (!again) setStep("failed");
    } finally { setBusy(false); }
  }, [account]);
  useEffect(() => { if (started.current) return; started.current = true; void sendCode(); }, [sendCode]);

  // Resend comes back quietly after a short wait: no timer on screen.
  useEffect(() => {
    if (lastSentAt === null) return;
    const t = setInterval(() => { if (canResend(lastSentAt, Date.now())) setResendReady(true); }, 1000);
    return () => clearInterval(t);
  }, [lastSentAt]);

  const finish = useCallback((session: unknown) => {
    if (!account || !mounted.current) return;
    const identity = `${accountId(account)}:${account.token}`;
    noteSessionInfo(session, identity);
    setStep("done");
    clearSessionExpired(identity);
    if (router.canGoBack()) router.back(); else router.replace("/channels");
  }, [account]);

  const verify = useCallback(async (value: string) => {
    if (!account || busy || value.length !== 6) return;
    submitted.current = value;
    setBusy(true); setError(null); setNotice(null);
    // Adding a first email proves the mailbox the same way; confirming it makes this device fresh too.
    const confirmEmail = async (): Promise<{ session: unknown }> => {
      await api.confirmMyEmail(account, challenge, value);
      if (mounted.current) emailConfirmed();
      const me = await api.me(account) as { session?: unknown };
      return { session: me?.session ?? null };
    };
    try {
      const out = step === "emailCode" ? await confirmEmail() : await api.sessionVerify(account, challenge, value);
      finish(out.session);
    } catch (e) {
      say(e, "Couldn't check the code. Try again.");
      if (e instanceof ServerError && e.code === "email_code_expired") setCode("");
    } finally { setBusy(false); }
  }, [account, busy, challenge, finish, step]);

  // Six digits typed, pasted or filled in: check them without another tap.
  const onCode = (raw: string) => {
    const next = cleanCode(raw);
    setCode(next); setError(null);
    if (next.length === 6 && submitted.current !== next) void verify(next);
  };

  const sendEmailCode = useCallback(async () => {
    if (!account || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const out = await api.sendMyEmailCode(account, emailDraft.trim());
      setChallenge(out.challenge); setMaskedEmail(out.email); setEmailDraft(out.email); setCode(""); submitted.current = "";
      setLastSentAt(Date.now()); setResendReady(false);
      setStep("emailCode");
    } catch (e) { say(e, "Couldn't send the code. Check the address and try again."); }
    finally { setBusy(false); }
  }, [account, busy, emailDraft]);

  const leave = async () => { await signOut(); };

  if (!account) return null;
  const codeStep = step === "code" || step === "emailCode";
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" testID="reverify">
        {accounts.length > 1 ? <ServerSwitcher /> : null}
        <Text accessibilityRole="header" style={styles.title}>Your session ended</Text>
        <Text style={styles.lead}>{expiryLead(maxHours, step === "emailCode" ? maskedEmail : codeStep ? maskedEmail : null, step === "email")}</Text>
        <Text style={styles.keep}>{account.user.name}</Text>

        {step === "sending" ? <Text style={styles.hint} accessibilityLiveRegion="polite">Sending your code…</Text> : null}

        {step === "failed" ? <>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Button label="Try again" onPress={() => void sendCode()} busy={busy} style={styles.action} />
        </> : null}

        {codeStep ? <>
          <Text style={styles.label} nativeID="reverifyCodeLabel">Six-digit code</Text>
          <TextInput
            testID="reverify-code"
            accessibilityLabelledBy="reverifyCodeLabel"
            accessibilityLabel="Six-digit code"
            value={code}
            onChangeText={onCode}
            autoFocus
            keyboardType="number-pad"
            inputMode="numeric"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={6}
            returnKeyType="done"
            onSubmitEditing={() => void verify(code)}
            editable={!busy}
            style={[styles.input, styles.codeInput, error && styles.inputError]}
          />
          {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Button label="Continue" onPress={() => void verify(code)} busy={busy} disabled={code.length !== 6} style={styles.action} />
          <View style={styles.row}>
            <Button label={resendReady ? "Send a new code" : "Code sent"} kind="secondary" disabled={!resendReady || busy}
              onPress={() => void (step === "emailCode" ? sendEmailCode() : sendCode(true))} style={styles.half} />
            {step === "emailCode" ? <Button label="Change email" kind="secondary" disabled={busy} onPress={() => { setStep("email"); setError(null); setNotice(null); }} style={styles.half} /> : null}
          </View>
          <Text style={styles.note}>Code expires in ten minutes.</Text>
        </> : null}

        {step === "email" ? <>
          <Text style={styles.label} nativeID="reverifyEmailLabel">Work email</Text>
          <TextInput
            testID="reverify-email"
            accessibilityLabelledBy="reverifyEmailLabel"
            accessibilityLabel="Work email"
            value={emailDraft}
            onChangeText={t => { setEmailDraft(t); setError(null); }}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            inputMode="email"
            textContentType="emailAddress"
            autoComplete="email"
            returnKeyType="send"
            onSubmitEditing={() => void sendEmailCode()}
            editable={!busy}
            placeholder="you@example.gov"
            placeholderTextColor={colors.muted}
            style={[styles.input, error && styles.inputError]}
          />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Button label="Send code" onPress={() => void sendEmailCode()} busy={busy} disabled={!emailDraft.trim()} style={styles.action} />
        </> : null}

        <View style={styles.section}>
          <Text style={styles.note}>Can't get a code? Contact the server owner.</Text>
          <Button label="Sign out of this device instead" kind="danger" onPress={() => void leave()} disabled={busy} style={styles.gap} />
        </View>
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
  hint: { ...typography.body, color: colors.muted, marginTop: space.xl },
  label: { ...typography.label, marginTop: space.xl, color: colors.ink },
  input: { ...controls.input, marginTop: space.xs },
  codeInput: { fontSize: typography.title.fontSize, lineHeight: typography.title.lineHeight, letterSpacing: 6, fontVariant: ["tabular-nums"], minHeight: 56 },
  inputError: { borderColor: colors.red },
  notice: { ...typography.caption, marginTop: space.xs, color: colors.green },
  error: { ...typography.caption, marginTop: space.xs, color: colors.red },
  action: { marginTop: space.md },
  row: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  half: { flex: 1 },
  note: { ...typography.caption, color: colors.muted, marginTop: space.sm },
  section: { marginTop: space.xl, paddingTop: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  gap: { marginTop: space.xs, alignSelf: "flex-start" },
}));
