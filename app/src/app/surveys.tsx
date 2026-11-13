import { useCallback, useRef, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Button } from '../components/Button';
import { useSession } from '../lib/session';
import { surveysApi, surveyError, surveyFaces, surveyRatingLabels, type Survey, type SurveyDetail } from '../lib/surveys';
import { NO_SURVEY_ACCESS, surveyPermissionsFromServer } from '../lib/survey-permissions';
import { radius, space, typography, createThemedStyles, useTheme } from '../lib/theme';

export default function Surveys() {
  const { account } = useSession();
  const styles = useStyles();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ survey?: string }>();
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [selected, setSelected] = useState(params.survey || '');
  const [detail, setDetail] = useState<SurveyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [permissions, setPermissions] = useState(NO_SURVEY_ACCESS);
  const [editor, setEditor] = useState<'new' | string | null>(null);
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('How was your experience?');
  const generation = useRef(0);
  const mutation = useRef(false);
  const refresh = useCallback(async () => {
    if (!account) return;
    const run = ++generation.current;
    setLoading(true); setError(''); setDetail(null); setSurveys([]); setPermissions(NO_SURVEY_ACCESS); setEditor(null);
    try {
      const list = await surveysApi.list(account);
      if (run !== generation.current) return;
      setSurveys(list.surveys); setPermissions(surveyPermissionsFromServer(list.permissions));
      const id = list.surveys.some(item => item.id === selected) ? selected : list.surveys[0]?.id;
      if (id) {
        const next = await surveysApi.detail(account, id);
        if (run === generation.current) { setDetail(next); setPermissions(surveyPermissionsFromServer(next.permissions)); }
      }
    } catch (e) {
      if (run === generation.current) { setError(surveyError(e)); setSurveys([]); setDetail(null); setPermissions(NO_SURVEY_ACCESS); setEditor(null); }
    } finally { if (run === generation.current) setLoading(false); }
  }, [account, selected]);
  useFocusEffect(useCallback(() => { void refresh(); return () => { generation.current++; }; }, [refresh]));

  const save = async () => {
    if (!account || !permissions.canManage || !editor || mutation.current || !title.trim() || !question.trim()) return;
    const run = generation.current;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const fields = { title: title.trim(), question: question.trim() };
      const { survey } = editor === 'new' ? await surveysApi.create(account, fields) : await surveysApi.update(account, editor, fields);
      if (run !== generation.current) return;
      setSurveys(items => editor === 'new' ? [survey, ...items] : items.map(item => item.id === survey.id ? survey : item));
      setDetail(value => value?.survey.id === survey.id ? { ...value, survey } : value);
      setSelected(survey.id); setEditor(null); setTitle('');
      setNotice(editor === 'new' ? 'Survey created.' : 'Survey updated.');
    } catch (e) { if (run === generation.current) setError(surveyError(e)); }
    finally { mutation.current = false; setBusy(false); }
  };
  const toggle = async () => {
    if (!account || !permissions.canManage || !detail || mutation.current) return;
    const run = generation.current;
    mutation.current = true; setBusy(true); setError('');
    try {
      const { survey } = await surveysApi.update(account, detail.survey.id, { closed: !detail.survey.closed });
      if (run !== generation.current) return;
      setDetail(value => value?.survey.id === survey.id ? { ...value, survey } : value);
      setSurveys(items => items.map(item => item.id === survey.id ? survey : item));
      setNotice(survey.closed ? 'Survey closed.' : 'Survey reopened.');
    } catch (e) { if (run === generation.current) setError(surveyError(e)); }
    finally { mutation.current = false; setBusy(false); }
  };
  const copy = async () => {
    if (!detail?.survey.shareUrl) return;
    try {
      if (!await Clipboard.setStringAsync(detail.survey.shareUrl)) throw new Error('Could not copy the link. Select and copy it below.');
      setNotice('Link copied.');
    } catch (e) { setError(surveyError(e)); }
  };
  if (!account) return null;
  return <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
    <Text style={styles.body}>Collect feedback privately. Responses and results are visible to authorized staff only.</Text>
    {permissions.canView && !permissions.canManage ? <Text style={styles.caption}>You have view access. A user researcher or admin can create and edit surveys.</Text> : null}
    {permissions.canManage ? <View style={styles.actions}><Button label={editor ? 'Cancel' : 'New survey'} kind="secondary" compact disabled={busy} onPress={() => { setEditor(editor ? null : 'new'); setTitle(''); setQuestion('How was your experience?'); setNotice(''); }} /></View> : null}
    {editor && permissions.canManage ? <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.heading}>{editor === 'new' ? 'New survey' : 'Edit survey'}</Text>
      <Text style={styles.label}>Name</Text><TextInput accessibilityLabel="Survey name" style={styles.input} value={title} onChangeText={setTitle} maxLength={120} editable={!busy} placeholderTextColor={colors.muted} />
      <Text style={styles.label}>Question</Text><TextInput accessibilityLabel="Survey question" style={styles.input} value={question} onChangeText={setQuestion} maxLength={240} editable={!busy} placeholderTextColor={colors.muted} />
      <Text style={styles.faces} accessibilityLabel="Ratings from 1, very unhappy, to 5, very happy">{surveyFaces.join('   ')}</Text>
      <Text style={styles.caption}>No personal information.</Text>
      <Button label={editor === 'new' ? 'Create survey' : 'Save changes'} busy={busy} disabled={!title.trim() || !question.trim()} onPress={save} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.caption}>{notice}</Text> : null}
    {surveys.length ? <View accessibilityRole="tablist" accessibilityLabel="Choose a survey" style={styles.selector}>{surveys.map(survey => <Pressable key={survey.id} accessibilityRole="tab" accessibilityState={{ selected: detail?.survey.id === survey.id, disabled: busy || !!editor }} aria-selected={detail?.survey.id === survey.id} disabled={busy || !!editor} onPress={() => { setSelected(survey.id); setNotice(''); }} style={[styles.tab, detail?.survey.id === survey.id && styles.tabSelected]}><Text style={[styles.tabText, detail?.survey.id === survey.id && styles.tabTextSelected]}>{survey.title}{survey.closed ? ' · Closed' : ''}</Text></Pressable>)}</View> : null}
    {loading ? <Text accessibilityLiveRegion="polite" style={styles.caption}>Loading surveys…</Text> : null}
    {!loading && !surveys.length && !error ? <Text style={styles.body}>No surveys.</Text> : null}
    {detail ? <>
      <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.heading}>{detail.survey.title}</Text><Text style={styles.body}>{detail.survey.question}</Text>
        <Text style={styles.caption}>{detail.survey.closed ? 'Closed' : 'Open'}</Text>
        {detail.survey.shareUrl ? <><Text selectable style={styles.url}>{detail.survey.shareUrl}</Text><View style={styles.actions}>
          <Button label="Copy link" compact onPress={copy} />
          <Button label="Open survey" kind="secondary" compact onPress={() => { void Linking.openURL(detail.survey.shareUrl!).catch(e => setError(surveyError(e))); }} />
          {Platform.OS !== 'web' ? <Button label="Share" kind="secondary" compact onPress={() => { void Share.share({ message: detail.survey.shareUrl! }).catch(e => setError(surveyError(e))); }} /> : null}
        </View></> : <Text style={styles.caption}>Survey address not configured.</Text>}
        {detail.survey.emailReady === false ? <Text style={styles.caption}>Email verification is not ready. Ask a server admin to configure the survey address and email delivery.</Text> : null}
        <View style={styles.actions}>{permissions.canManage ? <><Button label="Edit survey" kind="secondary" compact disabled={busy || !!editor} onPress={() => { setEditor(detail.survey.id); setTitle(detail.survey.title); setQuestion(detail.survey.question); setNotice(''); }} /><Button label={detail.survey.closed ? 'Reopen survey' : 'Close survey'} kind="secondary" compact busy={busy} disabled={!!editor} onPress={toggle} /></> : null}<Button label="View responses" kind="link" compact onPress={() => router.push({ pathname: '/queue', params: { survey: detail.survey.id } })} /></View>
      </View>
      <View style={styles.panel}>
        <Text accessibilityRole="header" style={styles.heading}>Results</Text>
        <View style={styles.metrics}><View><Text style={styles.metric}>{detail.results.total}</Text><Text style={styles.caption}>Responses</Text></View><View><Text style={styles.metric}>{detail.results.average == null ? '—' : detail.results.average.toFixed(1)}<Text style={styles.caption}> / 5</Text></Text><Text style={styles.caption}>Average rating</Text></View></View>
        {surveyFaces.map((face, index) => { const count = detail.results.distribution[index] || 0; const percent = detail.results.total ? Math.round(count / detail.results.total * 100) : 0; return <View key={index} style={styles.resultRow} accessible accessibilityLabel={`${index + 1}, ${surveyRatingLabels[index]}: ${count} responses, ${percent} percent`}><Text style={styles.face}>{face}</Text><Text style={styles.rating}>{index + 1}</Text><View style={styles.track}><View style={[styles.fill, { width: `${percent}%` }]} /></View><Text style={styles.count}>{count} · {percent}%</Text></View>; })}
      </View>
    </> : null}
    <Button label="Refresh" kind="link" disabled={loading || busy || !!editor} onPress={() => { void refresh(); }} />
  </ScrollView>;
}
const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, content: { padding: space.side, paddingBottom: space.xxl, gap: space.md, width: '100%', maxWidth: 840, alignSelf: 'center' },
  heading: { ...typography.heading, color: colors.ink }, body: { ...typography.body, color: colors.ink }, caption: { ...typography.caption, color: colors.muted }, label: { ...typography.label, color: colors.ink }, error: { ...typography.body, color: colors.red },
  panel: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space.md, gap: space.sm }, input: controls.input,
  faces: { fontSize: 30, textAlign: 'center', paddingVertical: space.sm }, selector: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // The filter tabs of Home, Direct messages and Agent.
  tab: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, justifyContent: 'center', borderRadius: radius.md }, tabSelected: { backgroundColor: colors.blueSoft }, tabText: { ...typography.bodyStrong, color: colors.muted }, tabTextSelected: { color: colors.blueDark },
  url: { ...typography.caption, color: colors.ink }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }, metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xl, paddingVertical: space.sm }, metric: { ...typography.display, color: colors.ink }, resultRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs }, face: { fontSize: 25, width: 36 }, rating: { ...typography.caption, color: colors.muted, width: 12 }, track: { flex: 1, height: 12, backgroundColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' }, fill: { height: '100%', backgroundColor: colors.primary }, count: { ...typography.caption, color: colors.ink, width: 80, textAlign: 'right' },
}));
