import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { patientLine, readableSteps, replyTime, workedFor, type AgentStep, type AgentTurn } from "../lib/agent-turns";
import { useNow } from "../lib/use-now";
import { FadeIn, LiveStatus, useReduceMotion } from "./LiveStatus";
import { ReplyBar } from "./ReplyBar";
import { AppIcon } from "./AppIcon";
import { createThemedStyles, space, typography, useTheme } from "../lib/theme";

// While the agent works: one calm line saying what it is doing ("Reading a file…"), and after the first minute
// a word about time. When the server can say how long replies like this usually take, that is about how long
// is left, with a thin bar under the line; when it can't, it is how long it has been. Tap the line for the
// steps so far, told plainly: what it did and, for the owner, what it worked on (the command, search, file or
// thought).
export function AgentProgress({ line: current, turn }: { line: string; turn: AgentTurn | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  // Nothing here counts seconds, so a slow tick is enough.
  const now = useNow(5_000);
  const steps = readableSteps(turn?.steps ?? []);
  const time = replyTime(turn, now);
  // A bare "Thinking" that has gone on a while says so in friendlier words.
  const line = patientLine(current, now - (turn?.startedAt ?? turn?.steps?.[0]?.at ?? now));
  const words = <>
    <LiveStatus text={line} style={styles.line} announce />
    {time.text ? <Text accessibilityLabel={time.spoken} style={styles.since}>· {time.text}</Text> : null}
  </>;
  const bar = time.progress === null ? null : <ReplyBar progress={time.progress} paused={time.paused} style={styles.bar} />;
  // Nothing to open yet: plain words, not a button that does nothing.
  if (!steps.length) return <View style={styles.wrap}><View testID="agent-progress" style={styles.head}>{words}</View>{bar}</View>;
  return (
    <View style={styles.wrap}>
      <Pressable testID="agent-progress" accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
        accessibilityLabel={`${line}${time.spoken ? `, ${time.spoken}` : ""}`} accessibilityHint={open ? "Hides the steps" : "Shows what it has done so far"}
        onPress={() => setOpen(o => !o)} style={({ pressed }) => [styles.head, pressed && styles.pressed]}>
        {words}
        <View style={open && styles.flip}><AppIcon name="chevronDown" size={14} color={colors.muted} /></View>
      </Pressable>
      {bar}
      {open ? <Steps steps={steps} /> : null}
    </View>
  );
}

// What a finished reply keeps of the work behind it: "Worked for 12 seconds". It opens to the same steps, fetched
// when asked for. `settle` is for the reply that finished while you watched: the line eases in where the live one was.
export function AgentWorked({ turn, load, settle = false }: { turn: AgentTurn; load: (turnId: string) => Promise<AgentStep[]>; settle?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const still = useReduceMotion();
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<AgentStep[] | null>(null);
  const [failed, setFailed] = useState(false);
  const summary = workedFor(turn);
  const spoken = workedFor(turn, true) ?? undefined;
  if (!summary) return null;
  const words = settle ? <FadeIn text={summary} still={still} style={styles.summary} /> : <Text style={styles.summary}>{summary}</Text>;
  if (!turn.stepCount) return <View testID="agent-worked" accessible accessibilityLabel={spoken} style={styles.plain}>{words}</View>;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || steps) return;
    setFailed(false);
    load(turn.id).then(found => setSteps(readableSteps(found)), () => setFailed(true));
  };
  return (
    <View style={styles.wrap}>
      <Pressable testID="agent-worked" accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
        accessibilityLabel={spoken} accessibilityHint={open ? "Hides the steps" : "Shows what it did"}
        onPress={toggle} style={({ pressed }) => [styles.head, pressed && styles.pressed]}>
        {words}
        <View style={open && styles.flip}><AppIcon name="chevronDown" size={14} color={colors.muted} /></View>
      </Pressable>
      {!open ? null : steps ? <Steps steps={steps} />
        : <Text accessibilityLiveRegion="polite" aria-live="polite" style={styles.note}>{failed ? "Couldn't load the steps. Close this and open it again to retry." : "Loading the steps…"}</Text>}
    </View>
  );
}

// Each step is a plain line: what it did, then what it worked on underneath when the server shares that.
function Steps({ steps }: { steps: AgentStep[] }) {
  const styles = useStyles();
  return (
    <View testID="agent-steps" style={styles.steps}>
      {steps.map((step, i) => (
        <View key={`${step.at}-${i}`}>
          <Text style={styles.label}>{step.label}</Text>
          {step.detail ? <Text selectable numberOfLines={4} style={[styles.detail, CODE.test(step.label) && styles.code]}>{step.detail}</Text> : null}
        </View>
      ))}
    </View>
  );
}

// Commands and file names read best in code type; searches and thoughts don't.
const CODE = /command|code|file/i;
const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });
const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  wrap: { flexShrink: 1, minWidth: 0 },
  // One line of words in a 44-point control. It overhangs the lines above and below, so the words sit where a
  // message's text would, right under the author, and the reply doesn't start a full row lower when it lands.
  // alignContent centers the words even though the row may wrap; without it they sit at the top.
  head: { alignSelf: "flex-start", maxWidth: "100%", minHeight: 44, marginTop: -space.xs, marginBottom: -space.xxs, flexDirection: "row", alignItems: "center", alignContent: "center", gap: space.xs, flexWrap: "wrap" },
  pressed: { opacity: 0.6 },
  line: { ...typography.body, color: colors.muted, flexShrink: 1 },
  since: { ...typography.body, color: colors.muted },
  // Under the words. The line's 44-point control overhangs it, so the bar sits close; what follows keeps its distance.
  bar: { marginBottom: space.xs },
  flip: { transform: [{ rotate: "180deg" }] },
  plain: { paddingTop: space.xxs, paddingBottom: space.xs },
  summary: { ...typography.caption, color: colors.muted },
  // A quiet rule down the left holds the steps together, like a quoted passage.
  steps: { marginTop: space.xxs, marginBottom: space.xs, paddingLeft: space.sm, borderLeftWidth: 2, borderLeftColor: colors.line, gap: space.xs },
  label: { ...typography.caption, color: colors.ink },
  detail: { ...typography.caption, color: colors.muted },
  code: { ...typography.meta, fontFamily: mono },
  note: { ...typography.caption, color: colors.muted, marginBottom: space.xs },
}));
