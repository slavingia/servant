import { useRef } from "react";
import { Platform, type View } from "react-native";

type Focusable = View & { focus?: () => void; contains?: (node: unknown) => boolean };
type KeyEvent = { key: string; target: unknown; preventDefault: () => void };

/**
 * ARIA radio group behaviour that also renders on the web: role and
 * aria-checked on each radio (react-native-web ignores accessibilityState),
 * one Tab stop for the group (the checked radio, or the first), and Arrow,
 * Home and End keys that move focus.
 *
 * By default selection follows focus, as native radios do. Pass
 * `activation: "manual"` when choosing has side effects (clearing work,
 * opening a sheet): then the keys only move focus, and Space or Enter
 * chooses the focused option.
 * Native platforms get the same roles and checked state.
 */
export function useRadioGroup<T extends string>({ values, value, onChange, label, disabled = false, activation = "auto" }: {
  values: readonly T[];
  value: T | null | undefined;
  onChange: (next: T) => void;
  label: string;
  disabled?: boolean;
  activation?: "auto" | "manual";
}) {
  const refs = useRef<(Focusable | null)[]>([]);
  const selected = value == null ? -1 : values.indexOf(value);
  const tabStop = selected >= 0 ? selected : 0;
  const web = Platform.OS === "web";
  const move = (index: number) => {
    if (activation === "auto") onChange(values[index]);
    refs.current[index]?.focus?.();
  };
  const onKeyDown = (raw: unknown) => {
    const event = raw as KeyEvent;
    if (disabled || !values.length) return;
    const from = refs.current.findIndex(node => !!node && (node === event.target || !!node.contains?.(event.target)));
    if (from < 0) return;
    const last = values.length - 1;
    if (event.key === " " || (event.key === "Enter" && activation === "manual")) {
      event.preventDefault();
      if (values[from] !== value) onChange(values[from]);
      return;
    }
    const next = { ArrowDown: from + 1, ArrowRight: from + 1, ArrowUp: from - 1, ArrowLeft: from - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    move((next + values.length) % values.length);
  };
  return {
    group: {
      accessibilityRole: "radiogroup" as const,
      role: "radiogroup" as const,
      accessibilityLabel: label,
      "aria-label": label,
      ...(web ? { onKeyDown } : {}),
    },
    radio: (option: T, index: number) => {
      const checked = selected === index;
      return {
        ref: (node: unknown) => { refs.current[index] = node as Focusable | null; },
        accessibilityRole: "radio" as const,
        role: "radio" as const,
        accessibilityState: { checked, disabled },
        "aria-checked": checked,
        ...(disabled ? { "aria-disabled": true } : {}),
        ...(web ? { tabIndex: (index === tabStop && !disabled ? 0 : -1) as 0 | -1 } : {}),
        disabled,
        onPress: () => { if (!disabled && option !== value) onChange(option); },
      };
    },
  };
}

/**
 * Space toggles a custom checkbox on the web, as it does a native one
 * (react-native-web only presses buttons with the keyboard).
 */
export function checkboxKeys(toggle: () => void, disabled = false) {
  if (Platform.OS !== "web") return {};
  return {
    onKeyDown: (raw: unknown) => {
      const event = raw as KeyEvent;
      if (disabled || event.key !== " ") return;
      event.preventDefault();
      toggle();
    },
  };
}
