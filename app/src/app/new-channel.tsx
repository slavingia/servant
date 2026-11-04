import { useState } from "react";
import { Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { AppIcon } from "../components/AppIcon";
import { api, ServerError } from "../lib/server";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";

const clean = (s: string) => s.toLowerCase().replace(/^#/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40);

export default function NewChannel() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const { refresh } = useLive();
  const [name, setName] = useState("");
  const [nameFocused, setNameFocused] = useState(false);
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!account) return null;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.createChannel(account, { name, private: priv });
      refresh();
      router.replace({ pathname: "/c/[id]", params: { id: c.id } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't make the channel");
      setBusy(false);
    }
  };
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Text style={styles.intro}>Channels bring the right people together.</Text>
      <Text style={styles.label}>Channel name</Text>
      <View style={[styles.nameBox, nameFocused && styles.nameBoxFocused]}>
        <AppIcon name={priv ? "lock" : "hash"} size={18} color={colors.muted} />
        <TextInput
          accessibilityLabel="Channel name"
          value={name}
          onChangeText={(t) => setName(clean(t))}
          placeholder="e.g. team-design"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onFocus={() => setNameFocused(true)}
          onBlur={() => setNameFocused(false)}
          style={styles.nameInput}
        />
      </View>
      <Text style={styles.help}>Use lowercase letters, numbers, and hyphens.</Text>

      <View style={styles.switchRow}>
        <View style={{ flex: 1, marginRight: space.sm }}>
          <Text style={styles.switchLabel}>Private channel</Text>
          <Text style={styles.help}>{priv ? "Only invited people can find and join it." : "Anyone in the workspace can find and join it."}</Text>
        </View>
        <Switch accessibilityLabel="Private channel" value={priv} onValueChange={setPriv} trackColor={{ true: colors.primary, false: colors.borderStrong }} thumbColor="#FFFFFF" {...(Platform.OS === "web" ? { activeThumbColor: "#FFFFFF" } : {})} />
      </View>

      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Button label="Create channel" onPress={create} busy={busy} disabled={!name} style={{ marginTop: space.lg }} />
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 680, alignSelf: "center" },
  intro: { ...typography.caption, color: colors.muted, marginBottom: space.xs },
  label: { ...typography.label, marginTop: space.md, marginBottom: space.xs, color: colors.ink },
  nameBox: { ...controls.input, paddingVertical: 0, flexDirection: "row", alignItems: "center", gap: space.xs },
  nameBoxFocused: { borderColor: colors.blue, boxShadow: `0 0 0 1px ${colors.blue}` },
  // The box draws the focus ring, so the inner field draws none.
  nameInput: { ...typography.body, flex: 1, minWidth: 0, minHeight: 44, paddingVertical: space.sm, color: colors.ink, ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) },
  help: { ...typography.caption, marginTop: space.xs, color: colors.muted },
  switchRow: { marginTop: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line, flexDirection: "row", alignItems: "center" },
  switchLabel: { ...typography.bodyStrong, color: colors.ink },
  error: { ...typography.caption, marginTop: space.md, color: colors.red },
}));
