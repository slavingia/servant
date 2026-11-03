import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { CHANNEL_SORTS, type ChannelSort } from "../lib/channel-sort";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// "Sort channels" choices as a small sheet over the list.
export function ChannelSortSheet({ visible, value, onChange, onClose }: { visible: boolean; value: ChannelSort; onChange: (sort: ChannelSort) => void; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
      <Pressable style={styles.sheet} accessibilityViewIsModal onPress={() => {}}>
        <Text accessibilityRole="header" style={styles.title}>Sort channels</Text>
        {CHANNEL_SORTS.map(sort => {
          const selected = sort.value === value;
          return <Pressable key={sort.value} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${sort.label}. ${sort.description}`}
            onPress={() => { onChange(sort.value); onClose(); }} style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
            <View style={styles.copy}>
              <Text style={[styles.label, selected && styles.selected]}>{sort.label}</Text>
              <Text style={styles.description}>{sort.description}</Text>
            </View>
            {selected ? <AppIcon name="check" size={20} color={colors.blue} /> : null}
          </Pressable>;
        })}
      </Pressable>
    </Pressable>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "flex-end", alignItems: "center", backgroundColor: "rgba(17,46,81,0.42)" },
  sheet: { width: "100%", maxWidth: 480, backgroundColor: colors.background, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.lg, paddingBottom: space.xxl },
  title: { ...typography.heading, color: colors.ink, paddingHorizontal: space.side, marginBottom: space.xs },
  option: { minHeight: 60, paddingHorizontal: space.side, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.sm },
  copy: { flex: 1, minWidth: 0 },
  label: { ...typography.body, color: colors.ink },
  selected: { ...typography.bodyStrong, color: colors.ink },
  description: { ...typography.caption, color: colors.muted, marginTop: 2 },
  pressed: { backgroundColor: colors.surface },
}));
