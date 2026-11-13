import { memo, type ReactNode } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { inlineMessage, messageBlocks, type Inline } from '../lib/message-format';
import type { GlossaryEntry } from '../lib/abbreviations';
import { useAbbreviations } from '../lib/use-abbreviations';
import { withAbbreviations } from './Abbr';
import { radius, space, typography, createThemedStyles } from '../lib/theme';

type Styles = ReturnType<typeof useStyles>;

function open(url: string) {
  // An agent chat link (from @agent handing work to a shared chat) opens inside the app.
  if (url.startsWith('/chat/')) { router.push({ pathname: '/chat/[id]', params: { id: url.slice(6) } }); return; }
  void Linking.openURL(url).catch(() => {});
}

function Inlines({ text, styles, abbreviations }: { text: string; styles: Styles; abbreviations: readonly GlossaryEntry[] }): ReactNode {
  return inlineMessage(text).map((part: Inline, i) => {
    const style = [
      part.strong && styles.strong, part.em && styles.em, part.strike && styles.strike,
      part.code && styles.inlineCode, part.url && styles.link,
    ];
    return part.url
      ? <Text key={i} style={style} accessibilityRole="link" onPress={() => open(part.url!)}>{part.text}</Text>
      : <Text key={i} style={style}>{part.code ? part.text : withAbbreviations(part.text, abbreviations)}</Text>;
  });
}

export const MessageText = memo(function MessageText({ text, failed = false }: { text: string; failed?: boolean }) {
  const styles = useStyles();
  const abbreviations = useAbbreviations();
  const body = [styles.body, failed && styles.failed];
  return <View style={styles.blocks}>{messageBlocks(text).map((block, index) => {
    switch (block.kind) {
      case 'code':
        return <View key={index} style={styles.codeBlock}>
          {block.language ? <Text style={styles.language}>{block.language}</Text> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator><Text selectable style={styles.code}>{block.text || ' '}</Text></ScrollView>
        </View>;
      case 'rule':
        return <View key={index} style={styles.rule} accessibilityElementsHidden importantForAccessibility="no" />;
      case 'table': {
        // Up to three columns fit the bubble and wrap; wider tables scroll sideways.
        const fits = block.header.length <= 3;
        const table = <View style={styles.table} accessibilityRole="summary">
            {[block.header, ...block.rows].map((row, r) => <View key={r} style={[styles.row, r === 0 && styles.headRow, r > 0 && r % 2 === 0 && styles.stripe]}>
              {row.map((cell, c) => <View key={c} style={[fits ? styles.fitCell : styles.cell, c > 0 && styles.cellDivider]}>
                <Text selectable style={[body, r === 0 && styles.strong, { textAlign: block.align[c] ?? 'left' }]}><Inlines text={cell} styles={styles} abbreviations={abbreviations} /></Text>
              </View>)}
            </View>)}
          </View>;
        return fits ? <View key={index}>{table}</View>
          : <ScrollView key={index} horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>{table}</ScrollView>;
      }
      case 'list': {
        const marker = block.checked === undefined
          ? <Text style={[styles.marker, /\d/.test(block.marker) && styles.number]}>{block.marker}</Text>
          : <Text accessibilityLabel={block.checked ? 'Done' : 'Not done'} style={[styles.marker, styles.box, block.checked && styles.boxDone]}>{block.checked ? '☑' : '☐'}</Text>;
        return <View key={index} style={[styles.list, { paddingLeft: block.depth * 18 }]}>
          {marker}
          <View style={styles.copy}><Text selectable style={[body, block.checked && styles.done]}><Inlines text={block.text} styles={styles} abbreviations={abbreviations} /></Text></View>
        </View>;
      }
      case 'heading':
        return <View key={index} style={index > 0 && styles.headingGap}>
          <Text selectable accessibilityRole="header" style={[body, block.level <= 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3]}><Inlines text={block.text} styles={styles} abbreviations={abbreviations} /></Text>
        </View>;
      case 'quote':
        return <View key={index} style={styles.quote}><Text selectable style={[body, styles.quoteText]}><Inlines text={block.text} styles={styles} abbreviations={abbreviations} /></Text></View>;
      default:
        return <View key={index}><Text selectable style={body}><Inlines text={block.text} styles={styles} abbreviations={abbreviations} /></Text></View>;
    }
  })}</View>;
});

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  blocks: { gap: space.xs }, body: { ...typography.body, color: colors.ink },
  // A message's headings step down from the heading role; none is larger than the screen's own.
  h1: { ...typography.heading }, h2: { ...typography.bodyStrong, fontWeight: '700' }, h3: { ...typography.bodyStrong },
  headingGap: { marginTop: space.xxs },
  strong: { fontWeight: '700' }, em: { fontStyle: 'italic' }, strike: { textDecorationLine: 'line-through' },
  link: { color: colors.blue, textDecorationLine: 'underline' },
  inlineCode: { fontFamily: mono, backgroundColor: colors.subtle, fontSize: 14 },
  codeBlock: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: space.sm, gap: space.xs },
  language: { ...typography.meta, color: colors.muted }, code: { ...typography.caption, fontFamily: mono, color: colors.ink },
  list: { flexDirection: 'row', gap: space.xs }, marker: { ...typography.body, color: colors.muted, minWidth: 16 }, number: { fontVariant: ['tabular-nums'] },
  box: { fontSize: 17 }, boxDone: { color: colors.green }, done: { color: colors.muted },
  copy: { flex: 1, minWidth: 0 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.borderStrong, paddingLeft: space.sm }, quoteText: { color: colors.muted },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderStrong, marginVertical: space.xs },
  tableScroll: { flexGrow: 0 },
  table: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  row: { flexDirection: 'row' }, headRow: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line }, stripe: { backgroundColor: colors.surface },
  cell: { width: 150, paddingHorizontal: space.sm, paddingVertical: space.xs }, fitCell: { flex: 1, minWidth: 0, paddingHorizontal: space.sm, paddingVertical: space.xs }, cellDivider: { borderLeftWidth: 1, borderLeftColor: colors.line },
  failed: { color: colors.red },
}));
