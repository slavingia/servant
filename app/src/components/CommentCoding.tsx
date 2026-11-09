import { memo, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import { checkboxKeys } from "./useRadioGroup";
import { SMALL_THEME_MIN, type Coding, type Comment, type CommentQuestion } from "../lib/readout-answers";
import { looksSensitive } from "../lib/readout";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Coding a readout's written comments: give each comment one or more themes,
 * and add a quote once it's been checked for identifying details. The comments
 * are shown here only while they're loaded; the coding is the researcher's and
 * is what's kept. Comments with the same words for the same question and design
 * are shown once, with how many people wrote them.
 */
export const CommentCoding = memo(function CommentCoding({ questions, comments, coding, onChange, taskTitle, hiddenIds }: {
  questions: CommentQuestion[];
  /** null when the export isn't loaded (a saved readout opened again). */
  comments: Comment[] | null;
  coding: Coding;
  onChange: (next: Coding) => void;
  taskTitle: (taskId: string | null) => string;
  hiddenIds: string[];
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [removing, setRemoving] = useState<string | null>(null);
  // With many comments, show the ones still to code.
  const [uncodedOnly, setUncodedOnly] = useState(false);
  const uncoded = comments ? new Set(comments.filter(c => !(coding.codes[c.key] ?? []).length).map(c => c.key)).size : 0;
  const used = (themeId: string) => coding.counts.filter(c => c.themeId === themeId).reduce((s, c) => s + c.n, 0);
  const removeTheme = (themeId: string) => {
    const codes: Coding["codes"] = {};
    for (const [key, ids] of Object.entries(coding.codes)) { const kept = ids.filter(id => id !== themeId); if (kept.length) codes[key] = kept; }
    onChange({ ...coding, themes: coding.themes.filter(t => t.id !== themeId), codes });
    setRemoving(null);
  };
  return <View style={styles.root}>
    {coding.themes.length ? <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.label}>Themes</Text>
      {coding.themes.map(t => <View key={t.id} style={styles.themeRow}>
        <Text style={styles.themeName}>{t.name}</Text>
        <Text style={styles.meta}>{used(t.id)} {used(t.id) === 1 ? "comment" : "comments"}</Text>
        {removing === t.id
          ? <><Button label="Remove" kind="secondary" compact accessibilityHint={`Removes ${t.name} from every comment`} onPress={() => removeTheme(t.id)} /><Button label="Keep" kind="link" compact onPress={() => setRemoving(null)} /></>
          : <Button label="Remove" kind="link" compact accessibilityHint={`Removes ${t.name} from every comment`} onPress={() => setRemoving(t.id)} />}
      </View>)}
      <Text style={styles.meta}>{`In what you share, counts under ${SMALL_THEME_MIN} show as "Fewer than ${SMALL_THEME_MIN}".`}</Text>
    </View> : null}

    {comments?.length ? <Pressable accessibilityRole="checkbox" role="checkbox" aria-checked={uncodedOnly} accessibilityState={{ checked: uncodedOnly }}
      accessibilityLabel={`Show only comments without a theme (${uncoded})`} {...checkboxKeys(() => setUncodedOnly(v => !v), false)}
      onPress={() => setUncodedOnly(v => !v)} style={({ pressed }) => [styles.check, pressed && styles.pressed]}>
      <View style={[styles.checkbox, uncodedOnly && styles.checkboxOn]}>{uncodedOnly ? <AppIcon name="check" size={14} color={colors.onPrimary} /> : null}</View>
      <Text style={styles.checkText}>{`Show only comments without a theme (${uncoded})`}</Text>
    </Pressable> : null}

    {questions.filter(q => q.designs.some(d => d.n)).map(q => <View key={q.questionId} style={styles.question}>
      <Text accessibilityRole="header" style={styles.questionTitle}>{taskTitle(q.taskId)}: {q.text}</Text>
      {comments === null ? <Text style={styles.meta}>
        {`${q.designs.reduce((s, d) => s + d.n, 0)} comments. Choose the follow-up survey export again and show the results to read and code them; your themes and quotes are kept.`}
      </Text> : q.designs.filter(d => d.n).map(d => {
        const groups = new Map<string, { key: string; text: string; count: number }>();
        for (const c of comments) if (c.questionId === q.questionId && c.designId === d.id && (!uncodedOnly || !(coding.codes[c.key] ?? []).length)) {
          const g = groups.get(c.key) ?? { key: c.key, text: c.text, count: 0 };
          g.count++;
          groups.set(c.key, g);
        }
        return <View key={d.id} style={styles.design}>
          <Text style={styles.label}>{`Design ${d.letter} · ${d.label} (${d.n} ${d.n === 1 ? "comment" : "comments"})${hiddenIds.includes(d.id) ? " · hidden in what you share" : ""}`}</Text>
          {[...groups.values()].map(g => <CommentCard key={g.key} questionId={q.questionId} designId={d.id} group={g} coding={coding} onChange={onChange} />)}
          {uncodedOnly && !groups.size ? <Text style={styles.meta}>Every comment here has a theme.</Text> : null}
        </View>;
      })}
    </View>)}
    <View style={styles.privacy}>
      <AppIcon name="lock" size={16} color={colors.blueDark} />
      <Text style={styles.privacyText}>Comments are shown only here, on this device, while the export is loaded. They aren't saved or shared. Only your themes, their counts and the quotes you add go in the readout.</Text>
    </View>
  </View>;
});

const CommentCard = memo(function CommentCard({ questionId, designId, group, coding, onChange }: {
  questionId: string;
  designId: string;
  group: { key: string; text: string; count: number };
  coding: Coding;
  onChange: (next: Coding) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState(group.text);
  const [checked, setChecked] = useState(false);
  // After adding a theme, focus moves to its chip on this comment (the name field it came from is gone).
  const [focusTheme, setFocusTheme] = useState<string | null>(null);
  const chips = useRef<Record<string, { focus?: () => void } | null>>({});
  useEffect(() => {
    if (!focusTheme) return;
    chips.current[focusTheme]?.focus?.();
    setFocusTheme(null);
  }, [focusTheme, coding.themes]);
  const codes = coding.codes[group.key] ?? [];
  const quoted = coding.quotes.find(q => q.key === group.key && q.questionId === questionId && q.designId === designId);
  const toggle = (themeId: string) => {
    const next = codes.includes(themeId) ? codes.filter(id => id !== themeId) : [...codes, themeId];
    const all = { ...coding.codes };
    if (next.length) all[group.key] = next; else delete all[group.key];
    onChange({ ...coding, codes: all });
  };
  const addTheme = () => {
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) return;
    const existing = coding.themes.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
    const theme = existing ?? { id: newId(), name: trimmed };
    onChange({ ...coding, themes: existing ? coding.themes : [...coding.themes, theme], codes: { ...coding.codes, [group.key]: [...codes.filter(id => id !== theme.id), theme.id] } });
    setName(""); setNaming(false); setFocusTheme(theme.id);
  };
  const sensitive = looksSensitive(quote);
  const addQuote = () => {
    if (!checked || sensitive || !quote.trim()) return;
    onChange({ ...coding, quotes: [...coding.quotes, { key: group.key, questionId, designId, text: quote.trim().slice(0, 1000) }] });
    setQuoting(false); setChecked(false);
  };
  return <View style={styles.comment}>
    <Text selectable style={styles.commentText}>{group.text}</Text>
    {group.count > 1 ? <Text style={styles.meta}>{`${group.count} people wrote this`}</Text> : null}
    <View style={styles.chips} accessibilityLabel="Themes for this comment">
      {coding.themes.map(t => {
        const on = codes.includes(t.id);
        return <Pressable key={t.id} ref={el => { chips.current[t.id] = el as unknown as { focus?: () => void } | null; }} accessibilityRole="checkbox" role="checkbox" aria-checked={on} accessibilityState={{ checked: on }} accessibilityLabel={`Theme: ${t.name}`}
          {...checkboxKeys(() => toggle(t.id), false)} onPress={() => toggle(t.id)} style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
          {on ? <AppIcon name="check" size={14} color={colors.onPrimary} /> : null}
          <Text style={[styles.chipText, on && styles.chipTextOn]}>{t.name}</Text>
        </Pressable>;
      })}
      {naming ? null : <Button label="New theme" kind="link" compact onPress={() => setNaming(true)} />}
    </View>
    {naming ? <View style={styles.inline}>
      <TextInput value={name} onChangeText={setName} accessibilityLabel="New theme name" placeholder="A short name for what this comment is about" maxLength={80} autoFocus
        onSubmitEditing={addTheme} returnKeyType="done" style={styles.input} />
      <Button label="Add" kind="secondary" compact disabled={!name.trim()} onPress={addTheme} />
      <Button label="Cancel" kind="link" compact onPress={() => { setName(""); setNaming(false); }} />
    </View> : null}
    {quoted ? <View style={styles.quoted}>
      <Text style={styles.meta}>{`In the readout as a quote: “${quoted.text}”`}</Text>
      <Button label="Remove quote" kind="link" compact onPress={() => onChange({ ...coding, quotes: coding.quotes.filter(q => q !== quoted) })} />
    </View> : quoting ? <View style={styles.quoteEditor}>
      <Text style={styles.label}>The quote as it will appear</Text>
      <Text style={styles.meta}>Remove or replace anything that could identify someone, like a name, a place or a number: write [name] or [number] instead.</Text>
      <TextInput value={quote} onChangeText={value => { setQuote(value); setChecked(false); }} accessibilityLabel="The quote as it will appear" multiline maxLength={1000} style={[styles.input, styles.quoteInput]} />
      {sensitive ? <Text accessibilityRole="alert" style={styles.error}>{`This looks like it has ${sensitive}. Remove it before adding the quote.`}</Text> : null}
      <Pressable accessibilityRole="checkbox" role="checkbox" aria-checked={checked} accessibilityState={{ checked }}
        accessibilityLabel="I've checked this quote for names, numbers and other details that could identify someone"
        {...checkboxKeys(() => setChecked(v => !v), false)} onPress={() => setChecked(v => !v)} style={({ pressed }) => [styles.check, pressed && styles.pressed]}>
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>{checked ? <AppIcon name="check" size={14} color={colors.onPrimary} /> : null}</View>
        <Text style={styles.checkText}>I&apos;ve checked this quote for names, numbers and other details that could identify someone</Text>
      </Pressable>
      <View style={styles.inline}>
        <Button label="Add to the readout" kind="secondary" compact disabled={!checked || !!sensitive || !quote.trim()} onPress={addQuote} />
        <Button label="Cancel" kind="link" compact onPress={() => { setQuoting(false); setChecked(false); setQuote(group.text); }} />
      </View>
    </View> : <Button label="Quote this" kind="link" compact onPress={() => setQuoting(true)} style={styles.quoteLink} />}
  </View>;
});

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { gap: space.md, marginHorizontal: space.side, marginBottom: space.md },
  card: { gap: space.xs, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface },
  label: { ...typography.captionStrong, color: colors.ink },
  meta: { ...typography.caption, color: colors.muted },
  themeRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, minHeight: 36 },
  themeName: { ...typography.caption, color: colors.ink, flexGrow: 1, flexShrink: 1, flexBasis: 140 },
  question: { gap: space.sm },
  questionTitle: { ...typography.bodyStrong, color: colors.ink },
  design: { gap: space.xs },
  comment: { gap: space.xs, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  commentText: { ...typography.body, color: colors.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs },
  chip: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
  chipOn: { borderColor: colors.blue, backgroundColor: colors.blue },
  chipText: { ...typography.caption, color: colors.ink },
  chipTextOn: { color: colors.onPrimary },
  pressed: { opacity: 0.75 },
  inline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs },
  input: { ...typography.body, flexGrow: 1, flexBasis: 200, minHeight: 44, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderStrong, color: colors.ink, backgroundColor: colors.background },
  quoteInput: { flexGrow: 0, flexBasis: "auto", minHeight: 88, textAlignVertical: "top" },
  quoteEditor: { gap: space.xs, paddingTop: space.xs },
  quoteLink: { alignSelf: "flex-start" },
  quoted: { gap: 2 },
  check: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm },
  checkbox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkboxOn: { borderColor: colors.blue, backgroundColor: colors.blue },
  checkText: { ...typography.caption, color: colors.ink, flex: 1 },
  error: { ...typography.caption, color: colors.red },
  privacy: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  privacyText: { ...typography.caption, color: colors.ink, flex: 1 },
}));
