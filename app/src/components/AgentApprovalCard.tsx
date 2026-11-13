import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AgentApproval } from '../lib/agent-turns';
import { radius, space, typography, createThemedStyles } from '../lib/theme';
import { Button } from './Button';

export function AgentApprovalCard({ approval, busy, error, onAnswer }: { approval: AgentApproval; busy?: boolean; error?: string | null; onAnswer: (choice: 'once' | 'deny') => void }) {
  const styles = useStyles();
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Approval required</Text>
    {approval.description ? <Text style={styles.description}>{approval.description}</Text> : null}
    {approval.command ? <ScrollView style={styles.commandBox} nestedScrollEnabled><Text selectable style={styles.command}>{approval.command}</Text></ScrollView> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <View style={styles.actions}>
      <Button label="Deny" kind="secondary" disabled={busy} onPress={() => onAnswer('deny')} style={styles.button} />
      <Button label="Allow once" busy={busy} onPress={() => onAnswer('once')} style={styles.button} />
    </View>
  </View>;
}
const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  card: { margin: space.side, padding: space.md, gap: space.xs, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg },
  title: { ...typography.bodyStrong, color: colors.ink }, description: { ...typography.caption, color: colors.ink },
  commandBox: { maxHeight: 130, borderRadius: radius.sm, padding: space.xs, backgroundColor: colors.background }, command: { ...typography.caption, color: colors.ink },
  error: { ...typography.caption, color: colors.red },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xxs }, button: { flexGrow: 1 },
}));
