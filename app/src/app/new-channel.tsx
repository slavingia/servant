import { useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { api, ServerError } from "../lib/server";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { colors, controls, space, typography } from "../lib/theme";

const clean = (s: string) => s.toLowerCase().replace(/^#/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40);

export default function NewChannel() {
  const { account } = useSession();
  const { refresh } = useLive();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!account) return null;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.createChannel(account, { name, topic, private: priv });
      refresh();
      router.replace({ pathname: "/c/[id]", params: { id: c.id } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't make the channel");
      setBusy(false);
    }
  };
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Text style={styles.intro}>Give your team a place to talk about a shared topic.</Text>
      <Text style={styles.label}>Channel name</Text>
      <View style={styles.nameBox}>
        <Text style={styles.hash}>#</Text>
        <TextInput
          accessibilityLabel="Channel name"
          value={name}
          onChangeText={(t) => setName(clean(t))}
          placeholder="team-budget"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={styles.nameInput}
        />
      </View>
      <Text style={styles.help}>Use lowercase letters, numbers, and hyphens.</Text>

      <Text style={styles.label}>Topic <Text style={styles.optional}>(optional)</Text></Text>
      <TextInput accessibilityLabel="Topic, optional" value={topic} onChangeText={setTopic} placeholder="What will you discuss here?" placeholderTextColor={colors.muted} style={styles.input} maxLength={250} multiline textAlignVertical="top" />

      <View style={styles.switchRow}>
        <View style={{ flex: 1, marginRight: space.sm }}>
          <Text style={styles.switchLabel}>Private channel</Text>
          <Text style={styles.help}>Only people you add can find it</Text>
        </View>
        <Switch accessibilityLabel="Private channel" value={priv} onValueChange={setPriv} trackColor={{ true: colors.blue }} />
      </View>

      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Button label="Create channel" onPress={create} busy={busy} disabled={!name} style={{ marginTop: space.lg }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  content: { padding: space.side, paddingBottom: space.xxl },
  intro: { ...typography.body, color: colors.muted, marginBottom: space.xs },
  label: { ...typography.label, marginTop: space.lg, marginBottom: space.xs, color: colors.ink },
  optional: { ...typography.caption, color: colors.muted },
  nameBox: { ...controls.input, paddingVertical: 0, flexDirection: "row", alignItems: "center" },
  hash: { ...typography.body, color: colors.muted, marginRight: space.xs },
  nameInput: { ...typography.body, flex: 1, minHeight: 52, paddingVertical: space.sm, color: colors.ink },
  input: { ...controls.input, ...controls.inputMultiline },
  help: { ...typography.caption, marginTop: space.xs, color: colors.muted },
  switchRow: { marginTop: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line, flexDirection: "row", alignItems: "center" },
  switchLabel: { ...typography.bodyStrong, color: colors.ink },
  error: { ...typography.caption, marginTop: space.md, color: colors.red },
});
