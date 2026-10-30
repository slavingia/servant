import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { pair, HubError } from "../lib/hub";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

// Opened by servant://pair?code=…&d=… links, the QR scanner, or Welcome.
// The team link asks for a name; a one-time invite already has one.
export default function Pair() {
  const params = useLocalSearchParams<{ code?: string; d?: string; hub?: string }>();
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
      const a = await pair({ code: String(params.code || ""), discovery: params.d || undefined, hub: params.hub || undefined }, withName);
      setAccount(a);
      router.replace("/channels");
    } catch (e) {
      if (e instanceof HubError && e.code === "name_required") setAskName(true);
      else setError(e instanceof HubError ? e.message : "Couldn't join. Try again");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!params.code || (!params.d && !params.hub)) {
      setError("That invite link is incomplete. Ask for a new one");
      return;
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !askName) {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Couldn't join</Text>
        <Text style={styles.body}>{error}</Text>
        <Button label="Try again" onPress={() => run()} style={{ marginTop: 24, alignSelf: "stretch" }} />
        <Button label={account ? "Back to Servant" : "Back"} kind="link" onPress={() => router.replace(account ? "/channels" : "/welcome")} style={{ marginTop: 8 }} />
      </View>
    );
  }
  if (askName) {
    const submit = () => name.trim() && run(name.trim());
    return (
      <KeyboardAvoidingView style={styles.form} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Text style={styles.title}>What's your name?</Text>
        <Text style={[styles.body, styles.left]}>Everyone on the team will see it</Text>
        <TextInput
          accessibilityLabel="Your name"
          value={name}
          onChangeText={setName}
          placeholder="Jordan Lee"
          placeholderTextColor="#8A8F96"
          style={styles.input}
          autoFocus
          autoComplete="name"
          textContentType="name"
          returnKeyType="join"
          onSubmitEditing={submit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button label="Join" onPress={submit} busy={busy} disabled={!name.trim()} style={{ marginTop: 24 }} />
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
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: colors.white },
  form: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: colors.white },
  title: { fontSize: 22, fontWeight: "700", color: colors.ink },
  body: { marginTop: 8, fontSize: 17, lineHeight: 24, color: colors.ink, textAlign: "center" },
  left: { textAlign: "left", color: colors.muted },
  input: { marginTop: 20, height: 50, borderWidth: 1.5, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  error: { marginTop: 12, color: colors.red, fontSize: 15 },
});
