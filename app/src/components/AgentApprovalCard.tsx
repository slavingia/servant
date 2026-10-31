import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AgentApproval } from '../lib/agent-turns';
import { colors, radius, space, typography } from '../lib/theme';
import { Button } from './Button';

export function AgentApprovalCard({ approval, busy, error, onAnswer }: { approval: AgentApproval; busy?: boolean; error?: string | null; onAnswer: (choice: 'once' | 'deny') => void }) {
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Your approval is needed</Text>
    <Text style={styles.description}>{approval.description || 'Review this action before the agent continues.'}</Text>
    {approval.command ? <ScrollView style={styles.commandBox} nestedScrollEnabled><Text selectable style={styles.command}>{approval.command}</Text></ScrollView> : null}
    <Text style={styles.detail}>Allow applies to this request only.</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <View style={styles.actions}>
      <Button label="Deny" kind="secondary" disabled={busy} onPress={() => onAnswer('deny')} style={styles.button} />
      <Button label="Allow once" busy={busy} onPress={() => onAnswer('once')} style={styles.button} />
    </View>
  </View>;
}
const styles = StyleSheet.create({
  card: { margin: space.side, padding: space.md, gap: space.xs, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg },
  title: { ...typography.bodyStrong, color: colors.ink }, description: { ...typography.caption, color: colors.ink },
  commandBox: { maxHeight: 130, borderRadius: radius.sm, padding: space.xs, backgroundColor: colors.white }, command: { ...typography.caption, color: colors.ink },
  detail: { ...typography.meta, color: colors.muted }, error: { ...typography.caption, color: colors.red },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xxs }, button: { flexGrow: 1 },
});
