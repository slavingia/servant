import { memo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { inlineMessage, messageBlocks } from '../lib/message-format';
import { colors, radius, space, typography } from '../lib/theme';

export const MessageText = memo(function MessageText({ text, failed = false }: { text: string; failed?: boolean }) {
  return <View style={styles.blocks}>{messageBlocks(text).map((block, index) => {
    if (block.kind === 'code') return <View key={index} style={styles.codeBlock}>
      {block.language ? <Text style={styles.language}>{block.language}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator><Text selectable style={styles.code}>{block.text || ' '}</Text></ScrollView>
    </View>;
    const content = <Text selectable accessibilityRole={block.kind === 'heading' ? 'header' : undefined} style={[styles.body, block.kind === 'heading' && styles.heading, failed && styles.failed]}>
      {inlineMessage(block.text).map((part, i) => <Text key={i} style={part.kind === 'strong' ? styles.strong : part.kind === 'em' ? styles.em : part.kind === 'code' ? styles.inlineCode : undefined}>{part.text}</Text>)}
    </Text>;
    if (block.kind === 'list') return <View key={index} style={styles.list}><Text style={styles.marker}>{block.marker}</Text><View style={styles.copy}>{content}</View></View>;
    if (block.kind === 'quote') return <View key={index} style={styles.quote}>{content}</View>;
    return <View key={index}>{content}</View>;
  })}</View>;
});

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const styles = StyleSheet.create({
  blocks: { gap: space.xs }, body: { ...typography.body, color: colors.ink },
  heading: { ...typography.bodyStrong }, strong: { fontWeight: '700' }, em: { fontStyle: 'italic' },
  inlineCode: { fontFamily: mono, backgroundColor: colors.subtle, fontSize: 14 },
  codeBlock: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: space.sm, gap: space.xs },
  language: { ...typography.meta, color: colors.muted }, code: { fontFamily: mono, fontSize: 13, lineHeight: 20, color: colors.ink },
  list: { flexDirection: 'row', gap: space.xs }, marker: { ...typography.body, color: colors.muted, minWidth: 16 }, copy: { flex: 1, minWidth: 0 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.borderStrong, paddingLeft: space.sm }, failed: { color: colors.red },
});
