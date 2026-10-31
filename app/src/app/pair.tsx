import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { pair, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { colors, controls, space, typography } from "../lib/theme";

// Opened by servant://pair?code=…&d=… links, the QR scanner, or Welcome.
// The team link asks for a name; a one-time invite already has one.
export default function Pair() {
  const params = useLocalSearchParams<{ code?: string; key?: string; d?: string; server?: string; hub?: string }>();
  // Links from the server still say "hub" so builds 2 and 3 can read them.
  const direct = params.server || params.hub || undefined;
  const { account, setAccount } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [askName, setAskName] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const run = async (withName?: string) => {
    setError(null);
    setBusy(true);
    try {
      const a = await pair({ code: String(params.code || ""), serverKey: params.key, discovery: params.d || undefined, server: direct }, withName);
      setAccount(a);
      router.replace("/channels");
    } catch (e) {
      if (e instanceof ServerError && e.code === "name_required") setAskName(true);
      else setError(e instanceof ServerError ? e.message : "Couldn't join. Try again");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!params.code || (!params.d && !direct)) {
      setError("That invite link is incomplete. Ask for a new one");
      return;
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <Text accessibilityRole="header" style={styles.title}>Introduce yourself</Text>
        <Text style={[styles.body, styles.left]}>Choose the name your teammates will see.</Text>
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
        <Button label="Join team" onPress={submit} busy={busy} disabled={!name.trim()} style={{ marginTop: space.lg }} />
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

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.side, backgroundColor: colors.white },
  form: { flex: 1, backgroundColor: colors.white },
  formContent: { flexGrow: 1, justifyContent: "center", padding: space.side, paddingVertical: space.xl },
  title: { ...typography.title, color: colors.ink },
  body: { ...typography.body, marginTop: space.xs, color: colors.muted, textAlign: "center" },
  left: { textAlign: "left", color: colors.muted },
  label: { ...typography.label, marginTop: space.xl, color: colors.ink },
  input: { ...controls.input, marginTop: space.xs },
  error: { ...typography.caption, marginTop: space.sm, color: colors.red },
});
