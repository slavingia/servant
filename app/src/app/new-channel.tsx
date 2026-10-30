import { useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { api, ServerError } from "../lib/server";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

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
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Name</Text>
      <View style={styles.nameBox}>
        <Text style={styles.hash}>#</Text>
        <TextInput
          accessibilityLabel="Channel name"
          value={name}
          onChangeText={(t) => setName(clean(t))}
          placeholder="for-example-budget"
          placeholderTextColor="#8A8F96"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={styles.nameInput}
        />
      </View>
      <Text style={styles.help}>Lowercase, no spaces</Text>

      <Text style={styles.label}>What's it for? (optional)</Text>
      <TextInput accessibilityLabel="Topic" value={topic} onChangeText={setTopic} placeholder="Planning next year's budget" placeholderTextColor="#8A8F96" style={styles.input} maxLength={250} />

      <View style={styles.switchRow}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={styles.switchLabel}>Private channel</Text>
          <Text style={styles.help}>Only people you add can find it</Text>
        </View>
        <Switch accessibilityLabel="Private channel" value={priv} onValueChange={setPriv} trackColor={{ true: colors.blue }} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Make channel" onPress={create} busy={busy} disabled={!name} style={{ marginTop: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  label: { marginTop: 16, marginBottom: 8, fontSize: 15, fontWeight: "600", color: colors.ink },
  nameBox: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface, paddingHorizontal: 14 },
  hash: { fontSize: 18, color: colors.muted, marginRight: 4 },
  nameInput: { flex: 1, minHeight: 50, fontSize: 17, color: colors.ink },
  input: { minHeight: 50, borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface, paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  help: { marginTop: 6, fontSize: 14, color: colors.muted },
  switchRow: { marginTop: 24, flexDirection: "row", alignItems: "center" },
  switchLabel: { fontSize: 17, color: colors.ink },
  error: { marginTop: 16, fontSize: 15, color: colors.red },
});
