import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Button, ButtonGroup } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ServeLoader } from "../components/ServeLoader";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { daysLabel, OFF_LINE, orderTokens, shellSetup, tokenLine, TOKEN_DAYS, WHAT_LINE, type AccessToken, type AccessTokensPage } from "../lib/access-tokens";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// Access tokens (docs/access-tokens.md): make a token to use Servant from a script or a shell on a computer where
// the app can't be installed. A token is shown once, here, when it is made, with the lines to paste into a shell;
// after that only its first and last characters are kept on screen. Revoking one stops it at once.
export default function AccessTokensScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [page, setPage] = useState<AccessTokensPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState<number>(90);
  const [busy, setBusy] = useState(false);
  // The token that was just made: on screen until the person says they have it.
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState<"token" | "setup" | null>(null);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try { setPage(await api.accessTokens(account)); setError(null); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't load your tokens. Try again"); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;

  const create = async () => {
    if (busy) return;
    if (!name.trim()) { setError("Name the token after where you will use it, for example Work laptop"); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.createAccessToken(account, name.trim(), days);
      setMade({ token: result.token, name: result.record.name }); setCopied(null); setName("");
      await load();
    } catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't make the token. Try again"); }
    finally { setBusy(false); }
  };
  const copy = async (what: "token" | "setup") => {
    if (!made) return;
    try { await Clipboard.setStringAsync(what === "token" ? made.token : shellSetup(page?.address ?? null, made.token)); setCopied(what); }
    catch { setError("Couldn't copy. Select the text and copy it yourself"); }
  };
  const revoke = async () => {
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true); setRevokeError(null);
    try { const next = await api.revokeAccessToken(account, revoking.id); setPage(current => current && { ...current, tokens: next.tokens }); setRevoking(null); }
    catch (e) { setRevokeError(e instanceof ServerError ? e.message : "Couldn't revoke it. Try again"); }
    finally { setRevokeBusy(false); }
  };

  return <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.body}>{WHAT_LINE}</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!page && !error ? <ServeLoader accessibilityLabel="Loading your tokens" style={styles.loading} /> : null}
    {page && !page.enabled ? <Text testID="tokens-off" style={styles.notice}>{OFF_LINE}</Text> : null}

    {made ? <View testID="token-made" style={styles.made}>
      <Text accessibilityRole="header" style={styles.section}>{`Your new token: ${made.name}`}</Text>
      <Text style={styles.body}>This is the only time it is shown. Copy it now.</Text>
      <Text testID="token-value" selectable style={styles.value}>{made.token}</Text>
      <Text style={styles.label}>To use it in PowerShell</Text>
      <Text testID="token-setup" selectable style={styles.value}>{shellSetup(page?.address ?? null, made.token)}</Text>
      <ButtonGroup>
        <Button testID="token-copy" label={copied === "token" ? "Token copied" : "Copy token"} compact onPress={() => void copy("token")} />
        <Button testID="token-copy-setup" label={copied === "setup" ? "Lines copied" : "Copy the PowerShell lines"} kind="secondary" compact onPress={() => void copy("setup")} />
        <Button testID="token-done" label="I have it" kind="link" compact onPress={() => setMade(null)} />
      </ButtonGroup>
    </View> : null}

    {page?.enabled ? <View style={styles.form}>
      <Text accessibilityRole="header" style={styles.section}>New token</Text>
      <Text style={styles.label}>Where you will use it</Text>
      <TextInput testID="token-name" accessibilityLabel="Where you will use it" value={name} onChangeText={value => { setName(value); setError(null); }} editable={!busy} maxLength={60}
        placeholder="Work laptop" placeholderTextColor={colors.muted} onSubmitEditing={() => void create()} returnKeyType="done" style={styles.input} />
      <Text style={styles.label}>How long it lasts</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="How long it lasts" style={styles.chips}>
        {TOKEN_DAYS.map(value => <Pressable key={value} testID={`token-days-${value}`} accessibilityRole="radio" accessibilityLabel={daysLabel(value)} accessibilityState={{ checked: days === value, disabled: busy }} aria-checked={days === value} disabled={busy}
          onPress={() => setDays(value)} style={[styles.chip, days === value && styles.chipOn]}>
          <Text style={[styles.chipText, days === value && styles.chipTextOn]}>{daysLabel(value)}</Text>
        </Pressable>)}
      </View>
      <ButtonGroup><Button testID="token-create" label="Make token" busy={busy} onPress={() => void create()} /></ButtonGroup>
      {page.address ? <Text testID="token-address" selectable style={styles.meta}>{`It works at ${page.address}. Opening that address in a browser shows how to use it.`}</Text> : null}
    </View> : null}

    {page?.tokens.length ? <View>
      <Text accessibilityRole="header" style={styles.section}>Your tokens</Text>
      <View style={styles.list}>
        {orderTokens(page.tokens).map(token => <View key={token.id} testID={`token-${token.id}`} style={styles.row}>
          <View style={styles.rowCopy}>
            <Text style={[styles.name, token.state !== "active" && styles.muted]}>{token.name}</Text>
            <Text style={styles.meta}>{`${token.hint} · ${tokenLine(token)}`}</Text>
          </View>
          {token.state === "active" ? <Button testID={`token-revoke-${token.id}`} label="Revoke" accessibilityLabel={`Revoke ${token.name}`} kind="danger" compact onPress={() => { setRevokeError(null); setRevoking(token); }} /> : null}
        </View>)}
      </View>
    </View> : null}
    <ConfirmDialog visible={!!revoking} title={`Revoke ${revoking?.name ?? "this token"}?`} description="Anything using it stops working at once. This can't be undone; make a new token if you need one." confirmLabel="Revoke"
      onConfirm={() => void revoke()} onCancel={() => setRevoking(null)} busy={revokeBusy} error={revokeError} />
  </ScrollView>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 720, alignSelf: "center", gap: space.md },
  body: { ...typography.body, color: colors.ink },
  error: { ...typography.body, color: colors.red },
  loading: { paddingVertical: space.lg },
  notice: { ...typography.body, color: colors.ink, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface },
  made: { gap: space.xs, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  value: { ...typography.caption, fontFamily: "monospace", color: colors.ink, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.background },
  form: { gap: space.xs },
  section: { ...typography.heading, color: colors.ink },
  label: { ...typography.label, color: colors.muted },
  input: controls.input,
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  chipOn: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  chipText: { ...typography.label, color: colors.ink },
  chipTextOn: { color: colors.blueDark },
  meta: { ...typography.caption, color: colors.muted },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, marginTop: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowCopy: { flex: 1, minWidth: 0 },
  name: { ...typography.bodyStrong, color: colors.ink },
  muted: { color: colors.muted },
}));
