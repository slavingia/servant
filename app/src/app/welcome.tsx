import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Band, PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { parseInvite } from "../lib/invite";
import { colors } from "../lib/theme";

export default function Welcome() {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const join = () => {
    const invite = parseInvite(text);
    if (!invite) {
      setError("That isn't an invite link. Ask the person who invited you to send it again");
      return;
    }
    router.push({ pathname: "/pair", params: { code: invite.code, d: invite.discovery ?? "", hub: invite.hub ?? "" } });
  };

  return (
    <View style={styles.root}>
      <Band />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <PageTitle>Welcome</PageTitle>
          <Text style={styles.lead}>Servant lets you message an agent run by someone at your agency. To start, you need an invite from them.</Text>

          <Text style={styles.label} nativeID="inviteLabel">
            Invite link
          </Text>
          <TextInput
            accessibilityLabelledBy="inviteLabel"
            value={text}
            onChangeText={(t) => {
              setText(t);
              setError(null);
            }}
            placeholder="servant://pair?code=…"
            placeholderTextColor="#8A8F96"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={[styles.input, error && styles.inputError]}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Button label="Join" onPress={join} disabled={!text.trim()} style={{ marginTop: 16 }} />
          {Platform.OS !== "web" ? <Button label="Scan an invite code" kind="link" onPress={() => router.push("/scan")} style={{ marginTop: 8 }} /> : null}

          <Text style={styles.note}>For non-sensitive work only. Don't share taxpayer information here until your agency approves Servant for it</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  body: { paddingBottom: 40 },
  lead: { marginTop: 12, marginHorizontal: 20, fontSize: 17, lineHeight: 24, color: colors.ink },
  label: { marginTop: 32, marginHorizontal: 20, fontSize: 15, fontWeight: "600", color: colors.ink },
  input: {
    marginTop: 8,
    marginHorizontal: 20,
    minHeight: 76,
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: colors.ink,
    textAlignVertical: "top",
  },
  inputError: { borderColor: colors.red },
  error: { marginTop: 8, marginHorizontal: 20, color: colors.red, fontSize: 15, lineHeight: 21 },
  note: { marginTop: 32, marginHorizontal: 20, fontSize: 14, lineHeight: 20, color: colors.muted },
});
