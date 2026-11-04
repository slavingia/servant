import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { TERMS_CHECKS, termsAcceptance } from "../lib/terms";
import { pair, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";

// Opened by servant://pair?code=…&d=… links, the QR scanner, or Welcome.
// The team link asks for a name; a one-time invite already has one.
export default function Pair() {
  const styles = useStyles();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ code?: string; key?: string; d?: string; server?: string; hub?: string }>();
  // Links from the server still say "hub" so builds 2 and 3 can read them.
  const direct = params.server || params.hub || undefined;
  const { account, setAccount } = useSession();
  const incomplete = !params.code || (!params.d && !direct);
  const [runError, setError] = useState<string | null>(null);
  const error = runError ?? (incomplete ? "That invite link is incomplete. Ask for a new one" : null);
  const [askName, setAskName] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState<string[]>([]);
  const [accepted, setAccepted] = useState(false);

  const run = async (withName?: string) => {
    setError(null);
    setBusy(true);
    try {
      const a = await pair({ code: String(params.code || ""), serverKey: params.key, discovery: params.d || undefined, server: direct }, withName, termsAcceptance());
      setAccount(a);
      router.replace("/channels");
    } catch (e) {
      if (e instanceof ServerError && e.code === "name_required") setAskName(true);
      else setError(e instanceof ServerError ? e.message : "Couldn't join. Try again");
    } finally {
      setBusy(false);
    }
  };

  if (!accepted && !error) {
    const all = agreed.length === TERMS_CHECKS.length;
    const toggle = (id: string) => setAgreed((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
    return (
      <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.formContent}>
        <Text accessibilityRole="header" style={styles.title}>Before you join</Text>
        <Text style={[styles.body, styles.left]}>Please read and check each one. Your agreement is recorded with the date and version.</Text>
        {TERMS_CHECKS.map((c) => {
          const on = agreed.includes(c.id);
          return (
            <Pressable key={c.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={c.label} accessibilityHint={c.detail} onPress={() => toggle(c.id)} style={styles.check}>
              <View style={[styles.box, on && styles.boxOn]}>{on ? <Text style={styles.tick}>✓</Text> : null}</View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkLabel}>{c.label}</Text>
                <Text style={styles.checkDetail}>{c.detail}</Text>
              </View>
            </Pressable>
          );
        })}
        <Button label="Agree and join" disabled={!all} onPress={() => { setAccepted(true); run(); }} style={{ marginTop: space.lg }} />
        <Button label="Cancel" kind="link" onPress={() => router.replace(account ? "/channels" : "/welcome")} style={{ marginTop: 8 }} />
      </ScrollView>
    );
  }
  if (error && !askName) {
    return (
      <View style={styles.root}>
        <Text accessibilityRole="header" style={styles.title}>Couldn't join</Text>
        <Text accessibilityRole="alert" style={styles.body}>{error}</Text>
        <Button label="Try again" busy={busy} onPress={() => run()} style={{ marginTop: space.lg, alignSelf: "stretch" }} />
        <Button label={account ? "Back to Servant" : "Back"} kind="link" onPress={() => router.replace(account ? "/channels" : "/welcome")} style={{ marginTop: 8 }} />
      </View>
    );
  }
  if (askName) {
    const submit = () => name.trim() && run(name.trim());
    return (
      <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>What should we call you?</Text>
        <Text style={[styles.body, styles.left]}>This is how you’ll appear to your teammates.</Text>
        <Text style={styles.label}>Your name</Text>
        <TextInput
          accessibilityLabel="Your name"
          value={name}
          onChangeText={setName}
          placeholder="Jordan Lee"
          placeholderTextColor={colors.muted}
          style={styles.input}
          autoFocus
          autoComplete="name"
          textContentType="name"
          returnKeyType="join"
          onSubmitEditing={submit}
        />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button label="Join workspace" onPress={submit} busy={busy} disabled={!name.trim()} style={{ marginTop: space.lg }} />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }
  return (
    <View style={styles.root}>
      <ActivityIndicator color={colors.blue} size="large" />
      <Text style={[styles.body, { marginTop: 16 }]}>Joining…</Text>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.side, backgroundColor: colors.background },
  form: { flex: 1, backgroundColor: colors.background },
  formContent: { padding: space.side, paddingVertical: space.lg, width: "100%", maxWidth: 480, alignSelf: "center" },
  title: { ...typography.heading, color: colors.ink },
  body: { ...typography.caption, marginTop: space.xs, color: colors.muted, textAlign: "center" },
  left: { textAlign: "left", color: colors.muted },
  label: { ...typography.label, marginTop: space.lg, color: colors.ink },
  input: { ...controls.input, marginTop: space.xs },
  error: { ...typography.caption, marginTop: space.sm, color: colors.red },
  check: { flexDirection: "row", gap: space.sm, marginTop: space.md, paddingVertical: space.xs },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.muted, alignItems: "center", justifyContent: "center", marginTop: 1 },
  boxOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  tick: { color: colors.onPrimary, fontSize: 15, fontWeight: "700", lineHeight: 18 },
  checkLabel: { ...typography.body, fontWeight: "600", color: colors.ink },
  checkDetail: { ...typography.caption, marginTop: 2, color: colors.muted },
}));
