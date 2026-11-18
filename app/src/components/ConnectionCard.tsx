import { useState } from "react";
import { Linking, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { cardLine, cardState, fieldProblem, formValid, formValues, KEPT_OUT_LINE, NO_AGENT_LINE, openLabel, RESTRICTED_LINE, type CardState, type ConnectionAgent, type ConnectionStanding, type ConnectPart, type ConnectTool } from "../lib/connections";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";

// The form a person fills in to give their agent their own credentials for a tool (docs/connections.md). It is shown
// in a chat when the agent asks for one, and from You → Connections. What is typed goes to the server once, is
// cleared here the moment it is saved, and is never shown again: afterwards the card is one line with the last four
// characters.
type Props = {
  tool: ConnectTool;
  state: CardState;
  last4?: string;
  /** For someone else reading the chat: how the request ended. */
  asked?: ConnectPart["status"];
  agent?: ConnectionAgent;
  /** Saved: where the person now stands. */
  onSaved: (mine: ConnectionStanding | null) => void;
  /** The quiet way out, on the right of the footer: "Decline" in a chat, "Cancel" on Connections. */
  dismissLabel?: string;
  onDismiss?: () => Promise<void> | void;
  /** Inside a dialog that already has an edge: no border of its own. */
  bare?: boolean;
};

export function ConnectionCard({ tool, state, last4, asked, agent, onSaved, dismissLabel = "Decline", onDismiss, bare }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state !== "form" && state !== "restricted") {
    return <View testID={`connect-${tool.id}`} style={[styles.card, styles.line, bare && styles.bare]}>
      <AppIcon name={state === "saved" ? "shield" : "plug"} size={16} color={colors.muted} />
      <Text accessibilityLiveRegion="polite" style={styles.lineText}>{cardLine(state, tool, last4, asked)}</Text>
    </View>;
  }

  const dismiss = async () => {
    if (!onDismiss || busy) return;
    setBusy("dismiss"); setError(null);
    // Nothing typed stays behind once the form goes.
    try { await onDismiss(); setValues({}); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't save that. Check your connection and try again"); }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!account || busy || !formValid(tool, values)) return;
    setBusy("save"); setError(null);
    try {
      const saved = await api.saveConnection(account, tool.id, formValues(tool, values));
      setValues({});
      onSaved(saved.tool.mine);
    } catch (e) { setError(e instanceof ServerError ? e.message : `Couldn't save your ${tool.name} token. Check your connection and try again`); }
    finally { setBusy(null); }
  };

  return <View testID={`connect-${tool.id}`} style={[styles.card, bare && styles.bare]}>
    <Text accessibilityRole="header" style={styles.title}>{tool.heading}</Text>
    {tool.help ? <Text style={styles.help}>{tool.help}</Text> : null}
    {state === "restricted"
      // Only the full agent runs commands, and commands are the only place a connection is used.
      ? <Text testID={`connect-${tool.id}-restricted`} style={styles.notice}>{agent === "none" ? NO_AGENT_LINE : RESTRICTED_LINE}</Text>
      : <>
        {tool.createUrl ? <View style={styles.open}>
          <Button testID={`connect-${tool.id}-open`} label={openLabel(tool)} accessibilityLabel={`${openLabel(tool)} in your browser to create a token`} kind="secondary" compact icon="external"
            onPress={() => { void Linking.openURL(tool.createUrl).catch(() => setError(`Couldn't open ${tool.createUrl}. Copy the address into your browser`)); }} style={styles.openButton} />
          <Text selectable style={styles.url}>{tool.createUrl}</Text>
        </View> : null}
        {tool.fields.map(field => {
          const problem = fieldProblem(field, values[field.key] ?? "");
          return <View key={field.key} style={styles.field}>
            {tool.fields.length > 1 ? <Text style={styles.label}>{field.label}</Text> : null}
            <TextInput testID={`connect-${tool.id}-${field.key}`} accessibilityLabel={field.label} value={values[field.key] ?? ""} onChangeText={typed => { setValues(v => ({ ...v, [field.key]: typed })); setError(null); }}
              placeholder={field.placeholder} placeholderTextColor={colors.muted} secureTextEntry={field.secret} autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false}
              keyboardType={field.secret ? "default" : field.key === "email" ? "email-address" : "url"} editable={!busy} maxLength={2000} onSubmitEditing={() => void save()} style={styles.input} />
            {problem ? <Text style={styles.problem}>{problem}</Text> : null}
          </View>;
        })}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button testID={`connect-${tool.id}-save`} label="Save securely" busy={busy === "save"} disabled={!!busy || !formValid(tool, values)} onPress={() => void save()} />
      </>}
    {state === "restricted" && error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <View style={styles.footer}>
      {state === "form" ? <View style={styles.kept}>
        <AppIcon name="shield" size={16} color={colors.muted} />
        <Text style={styles.keptText}>{KEPT_OUT_LINE}</Text>
      </View> : <View style={styles.kept} />}
      {onDismiss ? <Button testID={`connect-${tool.id}-dismiss`} label={dismissLabel} accessibilityLabel={dismissLabel === "Decline" ? `Decline to connect ${tool.name}` : dismissLabel} kind="link" compact busy={busy === "dismiss"} disabled={!!busy} onPress={() => void dismiss()} /> : null}
    </View>
  </View>;
}

/** The card as a part of the agent's message. What happens on this phone (saved, declined) shows at once. */
export function MessageConnectCard({ part }: { part: ConnectPart }) {
  const { account } = useSession();
  const [local, setLocal] = useState<{ state: "saved" | "declined"; last4?: string } | null>(null);
  const state = cardState(part, local?.state);
  return <ConnectionCard tool={part.tool} state={state} last4={local?.last4 ?? part.last4} asked={part.status} agent={part.agent}
    onSaved={mine => setLocal({ state: "saved", last4: mine?.last4 })}
    onDismiss={part.mine ? async () => { if (!account) return; await api.declineConnection(account, part.requestId); setLocal({ state: "declined" }); } : undefined} />;
}

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });
const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  card: { marginTop: space.xs, padding: space.md, gap: space.sm, maxWidth: 520, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg },
  bare: { marginTop: 0, padding: 0, maxWidth: undefined, backgroundColor: "transparent", borderWidth: 0 },
  line: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.sm },
  lineText: { ...typography.caption, color: colors.ink, flex: 1, minWidth: 0 },
  title: { ...typography.bodyStrong, color: colors.ink },
  help: { ...typography.caption, color: colors.muted },
  notice: { ...typography.body, color: colors.ink },
  open: { gap: space.xs, alignItems: "flex-start" },
  openButton: { alignSelf: "flex-start" },
  url: { ...typography.meta, fontFamily: MONO, color: colors.muted },
  field: { gap: space.xxs },
  label: { ...typography.label, color: colors.muted },
  input: { ...controls.input, fontFamily: MONO },
  problem: { ...typography.caption, color: colors.muted },
  error: { ...typography.caption, color: colors.red },
  footer: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs },
  kept: { flexDirection: "row", alignItems: "center", gap: space.xs, flex: 1, minWidth: 0 },
  keptText: { ...typography.caption, color: colors.muted, flex: 1, minWidth: 0 },
}));
