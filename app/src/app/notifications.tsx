import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNotifications } from '../lib/notifications';
import { Button } from '../components/Button';
import { radius, space, typography, createThemedStyles, linkUnderline } from '../lib/theme';
import type { NotificationPreferences } from '../lib/notifications-api';
import { Toggle } from "../components/Toggle";
const choices: { mode: NotificationPreferences['mode']; title: string }[] = [
  { mode: 'all', title: 'All messages' },
  { mode: 'mentions', title: 'Chats, mentions and replies' },
  { mode: 'none', title: 'No notifications' },
];
export default function NotificationSettings() {
  const styles = useStyles();
  const { supported, enabled, busy, error, preferences, enable, update } = useNotifications();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  if (!supported) return <ScrollView style={styles.root} contentContainerStyle={styles.content}><Text accessibilityRole="header" style={styles.title}>Notifications unavailable</Text><Text style={styles.description}>Available in the iPhone and Android app.</Text></ScrollView>;
  const paused = preferences.pausedUntil > now;
  return <ScrollView style={styles.root} contentContainerStyle={styles.content}>

    <Text style={styles.description}>Archived channels are muted.</Text>
    {!enabled ? <Button label="Enable notifications" busy={busy} onPress={enable} style={styles.enable} /> : <View style={styles.enabled}><Text style={styles.detail}>Notifications are enabled</Text><Pressable accessibilityRole="button" onPress={() => Linking.openSettings()} style={styles.settings}><Text style={styles.link}>Open system settings</Text></Pressable></View>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Text accessibilityRole="header" style={styles.label}>Notify me about</Text>
    {choices.map(choice => <Pressable key={choice.mode} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: preferences.mode === choice.mode, disabled: busy }} aria-checked={preferences.mode === choice.mode} onPress={() => update({ mode: choice.mode })} style={styles.row}>
      <View style={styles.copy}><Text style={styles.rowTitle}>{choice.title}</Text></View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.radio, preferences.mode === choice.mode && styles.radioSelected]}>{preferences.mode === choice.mode ? <View style={styles.radioDot} /> : null}</View>
    </Pressable>)}
    <Text accessibilityRole="header" style={styles.label}>Privacy</Text>
    <View style={styles.row}><View style={styles.copy}><Text style={styles.rowTitle}>Show sender and message</Text><Text style={styles.detail}>Off shows only “You have a new message”</Text></View>
      <Toggle label="Show sender and message" disabled={busy} value={preferences.contentPreviews !== false} onValueChange={v => update({ contentPreviews: v })} /></View>
    <Text accessibilityRole="header" style={styles.label}>Pause notifications</Text>
    {paused ? <><Text style={styles.description}>Paused until {new Date(preferences.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</Text><Pressable disabled={busy} accessibilityRole="button" onPress={() => update({ pausedUntil: 0 })} style={styles.settings}><Text style={styles.link}>Resume notifications</Text></Pressable></> : <View style={styles.pauseChoices}>{[['30 minutes', 30], ['1 hour', 60], ['8 hours', 480]].map(([label, minutes]) => <Pressable key={label} disabled={busy} accessibilityRole="button" onPress={() => update({ pausedUntil: Date.now() + Number(minutes) * 60000 })} style={styles.pause}><Text style={styles.link}>{label}</Text></Pressable>)}</View>}
  </ScrollView>;
}
const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, content: { padding: space.side, paddingBottom: space.xxl, width: '100%', maxWidth: 680, alignSelf: 'center' },
  title: { ...typography.bodyStrong, color: colors.ink, marginBottom: space.xs },
  description: { ...typography.caption, color: colors.muted },
  label: { ...typography.label, marginTop: space.lg, marginBottom: space.xs, color: colors.muted },
  row: { paddingVertical: space.sm, minHeight: 60, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  copy: { flex: 1, marginRight: space.md }, rowTitle: { ...typography.bodyStrong, color: colors.ink }, detail: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  radio: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.blue }, radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.blue },
  enable: { marginTop: space.lg }, enabled: { marginTop: space.md, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  settings: { minHeight: 44, justifyContent: 'center' }, link: { ...typography.captionStrong, color: colors.blue, ...linkUnderline },
  pauseChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }, pause: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm }, error: { ...typography.caption, marginTop: space.sm, color: colors.red },
}));
