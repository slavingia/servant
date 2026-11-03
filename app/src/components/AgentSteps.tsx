import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { agentProgressMeta, elapsed, type AgentTurn } from "../lib/agent-turns";
import { LiveStatus } from "./LiveStatus";
import { AppIcon } from "./AppIcon";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// The agent's live line ("Running a command…"), with how many steps and how
// long so far. Tap it for every step: what it did and, for the owner, what it
// worked on (the command, search, file or its reasoning).
export function AgentProgress({ line, turn }: { line: string; turn: AgentTurn | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const steps = turn?.steps ?? [];
  const meta = agentProgressMeta(turn, now);
  const start = turn?.startedAt ?? steps[0]?.at ?? now;
  const expandable = steps.length > 0;
  return (
    <View style={styles.wrap}>
      <Pressable testID="agent-progress" disabled={!expandable} accessibilityRole="button" accessibilityState={{ expanded: open, disabled: !expandable }} aria-expanded={expandable ? open : undefined}
        accessibilityLabel={`${line}${meta ? `, ${meta}` : ""}`} accessibilityHint={expandable ? (open ? "Hides the steps" : "Shows each step so far") : undefined}
        onPress={() => setOpen(o => !o)} hitSlop={6} style={({ pressed }) => [styles.head, pressed && { opacity: 0.6 }]}>
        <LiveStatus text={line} style={styles.line} />
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        {expandable ? <View style={open && styles.flip}><AppIcon name="chevronDown" size={14} color={colors.muted} /></View> : null}
      </Pressable>
      {open ? <View testID="agent-steps" style={styles.list}>
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return <View key={`${step.at}-${i}`} style={styles.step}>
            <View style={styles.rail}><View style={[styles.dot, last && styles.dotNow]} />{!last ? <View style={styles.line2} /> : null}</View>
            <View style={styles.copy}>
              <View style={styles.stepHead}>
                <Text style={[styles.label, last && styles.labelNow]}>{step.label}</Text>
                <Text style={styles.time}>{elapsed(step.at - start)}</Text>
              </View>
              {step.detail ? <Text selectable numberOfLines={4} style={[styles.detail, CODE.test(step.label) && styles.code]}>{step.detail}</Text> : null}
            </View>
          </View>;
        })}
      </View> : null}
    </View>
  );
}

// Commands and file names read best in code type; searches and reasoning don't.
const CODE = /command|code|file/i;
const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });
const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  wrap: { flexShrink: 1, minWidth: 0 },
  head: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  line: { ...typography.body, color: colors.muted, flexShrink: 1 },
  meta: { ...typography.meta, color: colors.muted },
  list: { marginTop: space.xs, paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.md, backgroundColor: colors.surface },
  step: { flexDirection: "row", gap: space.sm },
  rail: { width: 10, alignItems: "center", paddingTop: 6 },
  flip: { transform: [{ rotate: "180deg" }] },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.borderStrong },
  dotNow: { backgroundColor: colors.blue },
  line2: { flex: 1, width: 1, marginTop: 3, backgroundColor: colors.line },
  copy: { flex: 1, minWidth: 0, paddingBottom: space.xs },
  stepHead: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  label: { ...typography.caption, color: colors.ink, flexShrink: 1 },
  labelNow: { fontWeight: "600" },
  time: { ...typography.meta, color: colors.muted, marginLeft: "auto", fontVariant: ["tabular-nums"] },
  detail: { ...typography.caption, color: colors.muted, marginTop: 2 },
  code: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
}));
