import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
import {
  MAX_RESEARCH_COLLABORATORS,
  filterCandidates,
  withCollaborator,
  withoutCollaborator,
  type CollaboratorCandidate,
} from "../lib/research-collaborators";
import type { ResearchCollaborator } from "../lib/server";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

/**
 * Who else can open a research plan. Presentational only: the caller loads
 * people, saves through the server, and passes back the server's answer, so the
 * local preview can render the same control with sample people.
 */
export function ResearchCollaborators({ collaborators, candidates, saving, error, onChange, onAdding }: {
  collaborators: readonly ResearchCollaborator[];
  candidates: readonly CollaboratorCandidate[] | null;
  saving: boolean;
  error: string | null;
  onChange: (next: ResearchCollaborator[]) => void;
  /** Called when the picker opens, so the caller can load people once. */
  onAdding?: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const full = collaborators.length >= MAX_RESEARCH_COLLABORATORS;
  const shown = candidates ? filterCandidates(candidates, query).slice(0, 8) : null;

  return <View style={styles.root}>
    <Text accessibilityRole="header" style={styles.title}>Collaborators</Text>
    <Text style={styles.detail}>Add teammates with Researcher access so they can read this plan. During the research pilot, collaborators can view only: they can't send messages or change the plan.</Text>
    {collaborators.length === 0
      ? <Text style={styles.empty}>Only you and admins can see this plan.</Text>
      : collaborators.map(person => <View key={person.id} style={styles.row}>
        <View style={styles.rowCopy}>
          <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
          {!person.active ? <Text style={styles.paused}>Paused until they have Researcher access again</Text> : null}
        </View>
        <Text style={styles.paused}>Can view</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${person.name}`} disabled={saving}
          onPress={() => onChange(withoutCollaborator(collaborators, person.id))} hitSlop={8}
          style={({ pressed }) => [styles.remove, pressed && styles.pressed]}>
          <AppIcon name="close" size={16} color={colors.muted} />
        </Pressable>
      </View>)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!adding
      ? <Button label={full ? `Up to ${MAX_RESEARCH_COLLABORATORS} collaborators` : "Add a collaborator"} kind="secondary" compact disabled={saving || full}
        onPress={() => { setAdding(true); onAdding?.(); }} style={styles.add} />
      : <View style={styles.picker}>
        <TextInput accessibilityLabel="Search people" placeholder="Search people" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery}
          autoFocus autoCorrect={false} style={styles.search} />
        {shown === null
          ? <Text style={styles.detail}>Loading people…</Text>
          : shown.length === 0
            ? <Text style={styles.detail}>{query.trim() ? "No one matches that name." : "No one else is in this workspace yet."}</Text>
            : shown.map(person => <Pressable key={person.id} accessibilityRole="button"
              accessibilityLabel={person.eligible ? `Add ${person.name} with view access` : `${person.name}, unavailable: ${person.reason}`}
              accessibilityState={{ disabled: !person.eligible || saving }} disabled={!person.eligible || saving || full}
              onPress={() => { onChange(withCollaborator(collaborators, person, "view")); setQuery(""); setAdding(false); }}
              style={({ pressed }) => [styles.candidate, !person.eligible && styles.candidateOff, pressed && styles.pressed]}>
              <View style={styles.rowCopy}>
                <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
                {person.reason ? <Text style={styles.paused}>{person.reason}</Text> : null}
              </View>
              {person.eligible ? <AppIcon name="plus" size={16} color={colors.blueDark} /> : <AppIcon name="lock" size={15} color={colors.muted} />}
            </Pressable>)}
        <Button label="Cancel" kind="link" compact onPress={() => { setAdding(false); setQuery(""); }} />
      </View>}
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, gap: space.xs },
  title: { ...typography.captionStrong, color: colors.ink },
  detail: { ...typography.meta, color: colors.muted },
  empty: { ...typography.meta, color: colors.muted, fontStyle: "italic" },
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.sm },
  rowCopy: { flex: 1, minWidth: 0 },
  name: { ...typography.caption, color: colors.ink },
  paused: { ...typography.meta, color: colors.muted },
  remove: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  error: { ...typography.meta, color: colors.red },
  add: { alignSelf: "flex-start", marginTop: space.xs },
  picker: { gap: space.xs, marginTop: space.xs },
  search: { ...controls.input },
  candidate: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
  candidateOff: { opacity: 0.6 },
  pressed: { opacity: 0.7 },
}));
