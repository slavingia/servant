import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useIsFocused } from "expo-router";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { createDictationCoordinator, type DictationState } from "./dictation-session";
import { remembered } from "./remembered";

export type Dictation = DictationState & {
  available: boolean;
  toggle: () => void;
  finish: (graceMs?: number) => Promise<boolean>;
};

const coordinator = createDictationCoordinator({
  permission: () => ExpoSpeechRecognitionModule.requestPermissionsAsync(),
  start: lang => ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: true, addsPunctuation: true }),
  stop: () => ExpoSpeechRecognitionModule.stop(),
  abort: () => ExpoSpeechRecognitionModule.abort(),
  subscribe: listener => {
    const subscriptions = [
      ExpoSpeechRecognitionModule.addListener('start', () => listener({ type: 'start' })),
      ExpoSpeechRecognitionModule.addListener('end', () => listener({ type: 'end' })),
      ExpoSpeechRecognitionModule.addListener('result', event => listener({ type: 'result', text: event.results[0]?.transcript ?? '', isFinal: event.isFinal })),
      ExpoSpeechRecognitionModule.addListener('error', event => listener({ type: 'error', error: event.error })),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  },
}, { permissionMayBackgroundApp: Platform.OS === 'android' });

// Whether this phone can take dictation is a question for the system (a speech recognizer is made to ask it),
// answered while the composer draws for the first time. Every conversation, thread and chat has a composer, so
// each screen opened was held up by it. The answer is remembered, and asked again when the app comes back to
// the front, in case dictation was turned on or off in Settings meanwhile.
const recognitionAvailable = remembered(() => {
  try { return ExpoSpeechRecognitionModule.isRecognitionAvailable(); } catch { return false; }
});
AppState.addEventListener("change", state => { if (state === "active") recognitionAvailable.forget(); });

function deviceLanguage() {
  try { return Intl.DateTimeFormat().resolvedOptions().locale || "en-US"; } catch { return "en-US"; }
}

export function useDictation(onText: (spoken: string) => void): Dictation {
  const focused = useIsFocused();
  const [state, setState] = useState<DictationState>({ listening: false, partial: '', error: '' });
  const [available] = useState(recognitionAvailable.get);
  const commit = useRef(onText);
  useLayoutEffect(() => { commit.current = onText; });
  const session = useRef<ReturnType<typeof coordinator.createSession> | null>(null);
  useLayoutEffect(() => {
    // Route ownership and foreground state are separate: Android permission
    // Activities may temporarily background this still-focused conversation.
    const current = coordinator.createSession(spoken => commit.current(spoken), setState);
    session.current = current;
    current.setForeground(AppState.currentState !== 'background');
    current.setActive(focused);
    const subscription = AppState.addEventListener('change', appState => current.setForeground(appState !== 'background'));
    return () => { subscription.remove(); session.current = null; current.setActive(false); };
  }, [focused]);
  const toggle = useCallback(() => {
    // The same short grace as Send: iOS may never end a continuous run, and the words heard so far belong in the box.
    if (state.listening) void session.current?.finish(1200);
    else void session.current?.start(deviceLanguage());
  }, [state.listening]);
  const finish = useCallback((graceMs?: number) => session.current?.finish(graceMs) ?? Promise.resolve(false), []);
  return { ...state, available, toggle, finish };
}
