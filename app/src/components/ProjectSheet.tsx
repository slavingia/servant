import { Radio } from "./Radio";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { VIBE_CHOICE } from "../lib/new-chat-choice";
import type { Project } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// The id for "Prototyping" in the list; it isn't a project the server knows.
export { VIBE_CHOICE };

// "New chat" choices: talk to the agent as is, prototype with a
// preview (when the server has the prototypes project), or work in a project.
export function ProjectSheet({ visible, projects, vibe = true, selected = null, title = "New chat", onPick, onClose }: { visible: boolean; projects: Project[]; vibe?: boolean; selected?: string | null; title?: string; onPick: (project: string | null) => void; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const options: { id: string | null; name: string; description?: string }[] = [
    { id: null, name: "Agent" },
    ...(vibe ? [{ id: VIBE_CHOICE, name: "Prototyping" }] : []),
    ...projects.map(p => ({ id: p.id, name: p.name, description: p.description || p.repo || undefined })),
  ];
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
      <Pressable style={styles.sheet} accessibilityViewIsModal onPress={() => {}}>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        {options.map(option => <Radio key={option.id ?? "none"} testID={`project-${option.id ?? "none"}`} accessibilityState={{ checked: option.id === selected }} aria-checked={option.id === selected}
          accessibilityLabel={option.description ? `${option.name}. ${option.description}` : option.name}
          onPress={() => onPick(option.id)} style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
          <View style={styles.icon}><AppIcon name={option.id === VIBE_CHOICE ? "code" : option.id ? "project" : "sparkles"} size={17} color={colors.blueDark} /></View>
          <View style={styles.copy}>
            <Text style={styles.label}>{option.name}</Text>
            {option.description ? <Text style={styles.description}>{option.description}</Text> : null}
          </View>
          {option.id === selected ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
        </Radio>)}
      </Pressable>
    </Pressable>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "flex-end", alignItems: "center", backgroundColor: colors.scrim },
  sheet: { width: "100%", maxWidth: 480, backgroundColor: colors.background, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.lg, paddingBottom: space.xxl },
  title: { ...typography.heading, color: colors.ink, paddingHorizontal: space.side, marginBottom: space.xs },
  option: { minHeight: 56, paddingHorizontal: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  icon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, minWidth: 0 },
  label: { ...typography.body, color: colors.ink },
  description: { ...typography.caption, color: colors.muted, marginTop: 2 },
  pressed: { backgroundColor: colors.surface },
}));
