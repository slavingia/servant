import { useEffect, useId, useRef, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { newProblems, saveBlockedReason } from "../lib/research-methods";
import { createThemedStyles, space, typography } from "../lib/theme";

/**
 * What's still needed before a working draft can be saved, and the Save
 * button. Problems that newly appear are announced to assistive technology
 * (after typing settles), and a disabled Save says why, both visibly and as
 * the button's hint. Shared by the study form and the local preview.
 */
export function DraftChecklist({ problems, saveLabel, onSave, busy = false, disabled = false, notice }: {
  problems: readonly string[];
  saveLabel: string;
  onSave: () => void;
  busy?: boolean;
  disabled?: boolean;
  notice?: string | null;
}) {
  const styles = useStyles();
  const previous = useRef<readonly string[]>(problems);
  const [announcement, setAnnouncement] = useState("");
  const key = problems.join("\n");
  useEffect(() => {
    const added = newProblems(previous.current, problems);
    previous.current = problems;
    if (!added.length) return;
    // Wait for typing to settle so each keystroke isn't read out.
    const timer = setTimeout(() => {
      const message = `${added.length === 1 ? "New item to fix" : `${added.length} new items to fix`} before saving: ${added.join(". ")}.`;
      setAnnouncement(message);
      if (Platform.OS !== "web") AccessibilityInfo.announceForAccessibility(message);
    }, 700);
    return () => clearTimeout(timer);
    // `key` carries the problems' content; the array identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const reason = saveBlockedReason(problems);
  const reasonId = `draft-save-reason-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <View style={styles.root}>
    {problems.length ? <View accessibilityLabel="Needed before the working draft can be saved" style={styles.list}>
      <Text style={styles.help}>Needed before you can save the working draft:</Text>
      {problems.map(problem => <Text key={problem} style={styles.problem}>• {problem}</Text>)}
    </View> : null}
    {/* Read by screen readers on the web (aria-live); native platforms also get announceForAccessibility. */}
    <Text accessibilityLiveRegion="polite" style={styles.screenReaderOnly}>{problems.length ? announcement : ""}</Text>
    <Button label={saveLabel} kind="secondary" busy={busy} disabled={disabled || problems.length > 0} accessibilityHint={reason ?? undefined}
      describedBy={reason ? reasonId : undefined} onPress={onSave} />
    {reason ? <Text nativeID={reasonId} style={styles.help}>{reason}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.help}>{notice}</Text> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { gap: space.xs },
  list: { gap: space.xxs },
  help: { ...typography.caption, color: colors.muted },
  problem: { ...typography.caption, color: colors.ink },
  // Kept in the tree so the live region exists before it changes; the list above is what sighted people read.
  screenReaderOnly: { position: "absolute", width: 1, height: 1, overflow: "hidden", left: 0, top: 0 },
}));
