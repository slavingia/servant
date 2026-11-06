import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { MessageText } from "./MessageText";
import { api, type Account, type Project } from "../lib/server";
import { radius, space, typography, createThemedStyles } from "../lib/theme";

type Readme = Awaited<ReturnType<typeof api.projectReadme>>;

// The repo's README, pulled from GitHub by the server (cached there), so the project explains itself.
export function ProjectReadme({ account, project }: { account: Account; project: Project }) {
  const styles = useStyles();
  const [readme, setReadme] = useState<Readme | undefined>(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    if (!project.repo) return;
    api.projectReadme(account, project.id).then(r => { if (live) setReadme(r); }, () => { if (live) setReadme(null); });
    return () => { live = false; };
  }, [account, project.id, project.repo]);
  if (!project.repo || !readme) return null;
  return (
    <View>
      <View style={styles.sectionRow}>
        <Text accessibilityRole="header" style={styles.section}>README</Text>
        <Pressable accessibilityRole="link" accessibilityLabel={`Open ${readme.name} on GitHub`} hitSlop={8} style={styles.action} onPress={() => void Linking.openURL(`https://github.com/${project.repo}#readme`)}>
          <Text style={styles.link}>On GitHub</Text>
        </Pressable>
      </View>
      <View style={[styles.body, !open && styles.clipped]}>
        <MessageText text={readme.text} />
      </View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(o => !o)} style={styles.toggle}>
        <Text style={styles.link}>{open ? "Show less" : "Show all"}</Text>
      </Pressable>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.lg, paddingLeft: space.side, paddingRight: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  section: { ...typography.label, color: colors.muted },
  action: { minHeight: 44, paddingHorizontal: space.sm, justifyContent: "center" },
  link: { ...typography.bodyStrong, color: colors.blue },
  body: { marginHorizontal: space.side, marginTop: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  clipped: { maxHeight: 280, overflow: "hidden" },
  toggle: { minHeight: 44, justifyContent: "center", marginHorizontal: space.side },
}));
