import { useEffect, useState } from "react";
import { nameFromEmail } from "../lib/name-from-email";
import { KeyboardAvoidingView, Pressable, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Link, router, Stack, useLocalSearchParams } from "expo-router";
import { suggestEmail } from "../lib/email-nudge";
import { ApproveFromPhone } from "../components/ApproveFromPhone";
import { Button } from "../components/Button";
import { TERMS_CHECKS, termsAcceptance, termsLinks } from "../lib/terms";
import { describeJoinError } from "../lib/join-errors";
import { deviceLabel, discover, pair, sendEmailCode, ServerError, type Account, type EmailProof } from "../lib/server";
import { useSession } from "../lib/session";
import { ALL_FEATURES, landingHref, normalizeFeatures, useFeatures } from "../lib/features";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { CheckBox } from "../components/CheckBox";
import { ServeLoader } from "../components/ServeLoader";

type Problem = { code: string; message: string };
// After "name taken": ask (which way to prove it's you), approve (code on screen), taken (another email owns the name).
type Claim = null | "ask" | "approve" | "taken";

// Opened by servant://pair?code=…&d=… links, the QR scanner, Welcome or Sign in.
// The team link asks for a name; a one-time invite or a sign-in link already has one.
// mode=existing: the person said they already have an account, so copy and the
// unknown-email case are about signing in, not joining.
export default function Pair() {
  const styles = useStyles();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ code?: string; key?: string; d?: string; server?: string; hub?: string; mode?: string }>();
  // Links from the server still say "hub" so builds 2 and 3 can read them.
  const direct = params.server || params.hub || undefined;
  const existing = params.mode === "existing";
  const { account, setAccount } = useSession();
  const incomplete = !params.code || (!params.d && !direct);
  const [runError, setError] = useState<Problem | null>(null);
  const error = runError ?? (incomplete ? { code: "invalid_invite", message: "That link is incomplete" } : null);
  const [askName, setAskName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState<string[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [legalDiscovery, setLegalDiscovery] = useState<{ url: string; attempt: number; server?: string; failed?: boolean } | null>(null);
  const [legalAttempt, setLegalAttempt] = useState(0);
  const legalResult = legalDiscovery?.url === params.d && legalDiscovery?.attempt === legalAttempt ? legalDiscovery : null;
  const legalLinks = termsLinks(params.d ? legalResult?.server : direct);
  const legalError = params.d ? legalResult?.failed : !legalLinks;
  useEffect(() => {
    if (!params.d) return;
    const url = params.d;
    const controller = new AbortController();
    void discover(url, controller.signal).then(server => {
      if (!controller.signal.aborted) setLegalDiscovery({ url, attempt: legalAttempt, server, failed: !termsLinks(server) });
    }).catch(() => { if (!controller.signal.aborted) setLegalDiscovery({ url, attempt: legalAttempt, failed: true }); });
    return () => controller.abort();
  }, [params.d, legalAttempt]);
  // Email code step: "email" (type your address) → "code" (type the six digits). Only when the server asks for it.
  const [emailStep, setEmailStep] = useState<null | "email" | "code">(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState("");
  const [digits, setDigits] = useState("");
  const [proof, setProof] = useState<EmailProof | undefined>(undefined);
  const [claim, setClaim] = useState<Claim>(null);
  const [unknownEmail, setUnknownEmail] = useState(false);
  const invite = () => ({ code: String(params.code || ""), serverKey: params.key, discovery: params.d || undefined, server: direct });
  const landing = landingHref(useFeatures());
  const leave = () => router.replace(account ? landing : "/welcome");

  const sendCode = async () => {
    setEmailError(null);
    setBusy(true);
    try {
      const out = await sendEmailCode(invite(), email.trim());
      setChallenge(out.challenge);
      setEmail(out.email);
      setDigits("");
      setEmailStep("code");
    } catch (e) {
      if (e instanceof ServerError && /^(invite_|invalid_invite|rate_limited|encryption_required)/.test(e.code)) { setEmailStep(null); setError({ code: e.code, message: e.message }); }
      else setEmailError(e instanceof ServerError ? e.message : "Couldn't send the code. Check your connection and try again");
    } finally {
      setBusy(false);
    }
  };

  const signedIn = (a: Account) => {
    setAccount(a);
    // The pairing answer already says what this server uses; land on Home or the agent accordingly.
    // Someone who has just joined starts with the tour (tour.tsx); leaving it lands where they would have.
    router.replace(a.tourDue ? "/tour" : landingHref(a.features ? normalizeFeatures(a.features) : ALL_FEATURES));
  };
  const title = <Stack.Screen options={{ title: existing || claim ? "Signing in" : "Joining" }} />;

  const run = async (withName?: string, withProof: EmailProof | undefined = proof) => {
    setError(null);
    setNameError(null);
    setEmailError(null);
    setBusy(true);
    try {
      const a = await pair(invite(), withName, termsAcceptance(), withProof);
      signedIn(a);
    } catch (e) {
      if (!(e instanceof ServerError)) { setError({ code: "network", message: "Couldn't reach the server" }); return; }
      if (e.code === "email_required") { setEmailStep("email"); }
      else if (e.code === "email_code_wrong" || e.code === "email_code_expired") {
        setProof(undefined);
        if (e.code === "email_code_expired") setEmailStep("email");
        setEmailError(e.message);
      }
      else if (e.code === "name_taken") {
        const has = (e.details.existing as { hasEmail?: boolean } | undefined)?.hasEmail;
        if (!existing && !withProof) { setAskName(true); setNameError("That name is taken here. Try adding an initial."); }
        else if (has === false) setClaim("ask");
        else if (has === true) setClaim("taken");
        else { setAskName(true); setNameError("That name is taken here. Try adding an initial."); }
      }
      else if (e.code === "name_required") {
        setEmailStep(null);
        if (existing && withProof) setUnknownEmail(true);
        else { setName((n) => n || nameFromEmail(email)); setAskName(true); }
      }
      else setError({ code: e.code, message: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!accepted && !error) {
    const all = agreed.length === TERMS_CHECKS.length;
    const toggle = (id: string) => setAgreed((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.formContent}>
        {title}
        <Text accessibilityRole="header" style={styles.title}>{existing ? "Before you sign in" : "Before you join"}</Text>
        <Text style={[styles.body, styles.left]}>Your agreement is recorded with its date and version.</Text>
        {legalLinks ? <View style={styles.links}>
          <Link href={legalLinks.terms} target="_blank" style={styles.link}>Read the terms</Link>
          <Link href={legalLinks.privacy} target="_blank" style={styles.link}>Privacy policy</Link>
        </View> : legalError ? <View>
          <Text accessibilityRole="alert" style={styles.error}>Couldn't find your server's terms. Check your connection and try again.</Text>
          <Button label="Try again" kind="link" onPress={() => setLegalAttempt(value => value + 1)} />
        </View> : <Text style={styles.body}>Finding your server's terms…</Text>}
        {TERMS_CHECKS.map((c) => {
          const on = agreed.includes(c.id);
          return (
            <Pressable key={c.id} accessibilityRole="checkbox" aria-checked={on} accessibilityState={{ checked: on }} accessibilityLabel={c.label} accessibilityHint={c.detail} onPress={() => toggle(c.id)} style={styles.check}>
              <CheckBox on={on} style={styles.box} />
              <View style={{ flex: 1 }}>
                <Text style={styles.checkLabel}>{c.label}</Text>
                <Text style={styles.checkDetail}>{c.detail}</Text>
              </View>
            </Pressable>
          );
        })}
        <Button label={existing ? "Agree and sign in" : "Agree and join"} disabled={!all || !legalLinks} onPress={() => { setAccepted(true); run(); }} style={{ marginTop: space.lg }} />
        <Button label="Cancel" kind="link" onPress={leave} style={{ marginTop: 8 }} />
      </ScrollView>
    );
  }
  if (claim === "approve") {
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
        {title}
        <Text accessibilityRole="header" style={styles.title}>Approve from your other device</Text>
        <Text style={[styles.body, styles.left]}>This device will sign in as {name.trim()}.</Text>
        <ApproveFromPhone workspace={{ server: direct ?? "", serverKey: params.key ?? "", discovery: params.d || undefined }} device={deviceLabel()}
          onSignedIn={a => { suggestEmail(email); signedIn(a); }}>
          <Button label="Back" kind="link" onPress={() => setClaim("ask")} style={{ marginTop: space.sm }} />
        </ApproveFromPhone>
      </ScrollView>
    );
  }
  if (claim === "ask") {
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.formContent}>
        {title}
        <Text accessibilityRole="header" style={styles.title}>Someone named {name.trim()} is already here</Text>
        <Text style={[styles.body, styles.left]}>That account has no work email. Approve from a signed-in device to use it.</Text>
        <Button label="Approve from my other device" onPress={() => setClaim("approve")} style={{ marginTop: space.lg }} />
        <Button label="Paste a sign-in link instead" kind="secondary" onPress={() => router.replace("/sign-in")} style={{ marginTop: space.sm }} />
        <Button label="That's not me. Use a different name" kind="link" onPress={() => { setClaim(null); setName(""); setAskName(true); }} style={{ marginTop: space.sm }} />
      </ScrollView>
    );
  }
  if (claim === "taken") {
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.formContent}>
        {title}
        <Text accessibilityRole="header" style={styles.title}>That name is taken</Text>
        <Text style={[styles.body, styles.left]}>{name.trim()} uses a different work email. Use that email or choose another name.</Text>
        <Button label="Use a different name" onPress={() => { setClaim(null); setName(""); setAskName(true); }} style={{ marginTop: space.lg }} />
        <Button label="Try another email" kind="secondary" onPress={() => { setClaim(null); setProof(undefined); setAskName(false); setEmailStep("email"); }} style={{ marginTop: space.sm }} />
        <Button label="Paste a sign-in link instead" kind="link" onPress={() => router.replace("/sign-in")} style={{ marginTop: space.sm }} />
      </ScrollView>
    );
  }
  if (unknownEmail) {
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.formContent}>
        {title}
        <Text accessibilityRole="header" style={styles.title}>No account has that email yet</Text>
        <Text style={[styles.body, styles.left]}>{email} isn't linked to an account. Use a sign-in link from your other device or join below.</Text>
        <Button label="Get a sign-in link" onPress={() => router.replace("/sign-in")} style={{ marginTop: space.lg }} />
        <Button label="Try another email" kind="secondary" onPress={() => { setUnknownEmail(false); setProof(undefined); setEmailStep("email"); }} style={{ marginTop: space.sm }} />
        <Button label="Join as a new person" kind="link" onPress={() => { setUnknownEmail(false); setName((n) => n || nameFromEmail(email)); setAskName(true); }} style={{ marginTop: space.sm }} />
      </ScrollView>
    );
  }
  if (emailStep && !error) {
    const code = emailStep === "code";
    const submit = () => {
      if (code) {
        const p = { challenge, code: digits.trim() };
        setProof(p);
        run(undefined, p);
      } else sendCode();
    };
    const ready = code ? digits.replace(/\D/g, "").length === 6 : /\S+@\S+\.\S+/.test(email.trim());
    return (
      <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
        {title}
        <Text accessibilityRole="header" style={styles.title}>{code ? "Enter your code" : "What's your work email?"}</Text>
        <Text style={[styles.body, styles.left]}>{code ? `We sent a six-digit code to ${email}. It works for ten minutes.` : existing ? "Enter the work email on your account. We'll email you a six-digit code." : "We'll email you a six-digit code to confirm it's you."}</Text>
        <Text style={styles.label}>{code ? "Code" : "Work email"}</Text>
        <TextInput
          key={emailStep}
          accessibilityLabel={code ? "Six-digit code" : "Work email"}
          value={code ? digits : email}
          onChangeText={code ? (t) => { setDigits(t.replace(/\D/g, "").slice(0, 6)); setEmailError(null); } : (t) => { setEmail(t); setEmailError(null); }}
          placeholder={code ? "123456" : "you@example.com"}
          placeholderTextColor={colors.muted}
          style={styles.input}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={code ? "number-pad" : "email-address"}
          autoComplete={code ? "one-time-code" : "email"}
          textContentType={code ? "oneTimeCode" : "emailAddress"}
          returnKeyType={code ? "join" : "send"}
          onSubmitEditing={() => ready && submit()}
        />
        {emailError ? <Text accessibilityRole="alert" style={styles.error}>{emailError}</Text> : null}
        <Button label={code ? (existing ? "Sign in" : "Join workspace") : "Send code"} onPress={submit} busy={busy} disabled={!ready} style={{ marginTop: space.lg }} />
        {code ? <Button label="Send a new code" kind="link" onPress={() => { setEmailError(null); setEmailStep("email"); }} style={{ marginTop: 8 }} /> : null}
        {!code && !existing ? <Button label="I already have an account" kind="link" onPress={() => router.replace("/sign-in")} style={{ marginTop: 8 }} /> : null}
        <Button label="Cancel" kind="link" onPress={leave} style={{ marginTop: 8 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }
  if (error) {
    const problem = describeJoinError(error.code, error.message, { existing });
    const act = () => {
      if (problem.action === "retry") { setError(null); void run(); }
      else if (problem.action === "new-link") router.replace("/sign-in");
      else if (problem.action === "new-invite") router.replace({ pathname: "/welcome", params: { new: "1" } });
      else leave();
    };
    return (
      <View style={styles.root}>
        {title}
        <Text accessibilityRole="header" style={[styles.title, { textAlign: "center" }]}>{problem.title}</Text>
        <Text accessibilityRole="alert" style={styles.body}>{problem.message}</Text>
        <Button label={problem.actionLabel} busy={busy} onPress={act} style={{ marginTop: space.lg, alignSelf: "stretch" }} />
        {problem.action === "new-invite" && !account ? <Button label="I already have an account" kind="secondary" onPress={() => router.replace("/sign-in")} style={{ marginTop: space.sm, alignSelf: "stretch" }} /> : null}
        {problem.action !== "back" ? <Button label={account ? "Back to Servant" : "Back"} kind="link" onPress={leave} style={{ marginTop: 8 }} /> : null}
      </View>
    );
  }
  if (askName) {
    const submit = () => name.trim() && run(name.trim());
    return (
      <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
        {title}
        <Text accessibilityRole="header" style={styles.title}>Join workspace</Text>
        <Text style={styles.label}>Your name</Text>
        <TextInput
          accessibilityLabel="Your name"
          value={name}
          onChangeText={(t) => { setName(t); setNameError(null); }}
          placeholder="Your full name"
          placeholderTextColor={colors.muted}
          style={styles.input}
          autoFocus
          autoComplete="name"
          textContentType="name"
          returnKeyType="join"
          onSubmitEditing={submit}
        />
        {nameError ? <Text accessibilityRole="alert" style={styles.error}>{nameError}</Text> : null}
        <Button label="Join workspace" onPress={submit} busy={busy} disabled={!name.trim()} style={{ marginTop: space.lg }} />
        {nameError ? <Button label="I already have an account" kind="link" onPress={() => router.replace("/sign-in")} style={{ marginTop: 8 }} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }
  return (
    <View style={styles.root}>
      {title}
      <ServeLoader size="large" />
      <Text style={[styles.body, { marginTop: 16 }]}>{existing ? "Signing in…" : "Joining…"}</Text>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.side, backgroundColor: colors.background, width: "100%", maxWidth: 480, alignSelf: "center" },
  form: { flex: 1, backgroundColor: colors.background },
  formContent: { padding: space.side, paddingVertical: space.lg, width: "100%", maxWidth: 480, alignSelf: "center" },
  title: { ...typography.heading, color: colors.ink },
  body: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center" },
  left: { textAlign: "left", color: colors.muted },
  links: { flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: space.xs },
  link: { ...typography.caption, color: colors.blue, textDecorationLine: "underline", paddingVertical: space.sm, minHeight: 44 },
  label: { ...typography.label, marginTop: space.lg, color: colors.ink },
  input: { ...controls.input, marginTop: space.xs },
  error: { ...typography.caption, marginTop: space.sm, color: colors.red },
  check: { flexDirection: "row", gap: space.sm, marginTop: space.md, paddingVertical: space.xs },
  box: { marginTop: 1 },
  checkLabel: { ...typography.body, fontWeight: "600", color: colors.ink },
  checkDetail: { ...typography.caption, marginTop: 2, color: colors.muted },
}));
