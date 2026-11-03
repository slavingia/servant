import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { AppIcon } from "./AppIcon";
import type { Project } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// "New chat" choices: talk to the agent as is, or about one project on the Mac.
export function ProjectSheet({ visible, projects, onPick, onClose }: { visible: boolean; projects: Project[]; onPick: (project: string | null) => void; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const options: { id: string | null; name: string; description?: string }[] = [
    { id: null, name: "Just the agent", description: "No project. Ask anything." },
    ...projects.filter(p => p.id !== "mac").map(p => ({ id: p.id, name: p.name, description: p.description })),
    ...projects.filter(p => p.id === "mac").map(p => ({ id: p.id, name: p.name, description: p.description })),
  ];
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
      <Pressable style={styles.sheet} accessibilityViewIsModal onPress={() => {}}>
        <Text accessibilityRole="header" style={styles.title}>New chat about</Text>
        {options.map(option => <Pressable key={option.id ?? "none"} testID={`project-${option.id ?? "none"}`} accessibilityRole="button"
          accessibilityLabel={option.description ? `${option.name}. ${option.description}` : option.name}
          onPress={() => onPick(option.id)} style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
          <View style={styles.icon}><AppIcon name={option.id ? "hash" : "sparkles"} size={17} color={colors.blueDark} /></View>
          <View style={styles.copy}>
            <Text style={styles.label}>{option.name}</Text>
            {option.description ? <Text style={styles.description}>{option.description}</Text> : null}
          </View>
        </Pressable>)}
      </Pressable>
    </Pressable>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "flex-end", alignItems: "center", backgroundColor: "rgba(17,46,81,0.42)" },
  sheet: { width: "100%", maxWidth: 480, backgroundColor: colors.background, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.lg, paddingBottom: space.xxl },
  title: { ...typography.heading, color: colors.ink, paddingHorizontal: space.side, marginBottom: space.xs },
  option: { minHeight: 56, paddingHorizontal: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  icon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, minWidth: 0 },
  label: { ...typography.body, color: colors.ink },
  description: { ...typography.caption, color: colors.muted, marginTop: 2 },
  pressed: { backgroundColor: colors.surface },
}));
