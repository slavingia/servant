// A right-click menu for the browser and the Mac app (docs/design-system.md, "Menus"). A mouse or trackpad gets the
// actions a long press opens on a phone, at the pointer, instead of the browser's Back, Reload and Inspect. Touch
// screens never see it. Selected text and links keep the browser's own menu, so copying a phrase or opening a link
// in a new tab still works, and so does a right-click with Shift held.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

export type ContextMenuItem =
  | { label: string; onPress: () => void; destructive?: boolean; hint?: string }
  | { separator: true }
  | { row: ReactNode; key: string };

type Opened = { x: number; y: number; items: ContextMenuItem[] };

const MENU_WIDTH = 240;

/** True where a right-click menu makes sense: the web build with a fine pointer (a mouse or trackpad). */
export function contextMenuSupported() {
  return Platform.OS === "web" && typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches;
}

type MouseLike = { preventDefault: () => void; stopPropagation?: () => void; shiftKey?: boolean; clientX?: number; clientY?: number; nativeEvent?: { clientX?: number; clientY?: number; pageX?: number; pageY?: number }; target?: unknown };

/** Whether this right-click should keep the browser's menu: text is selected, it's on a link or a field, or Shift is held. */
export function keepsBrowserMenu(e: MouseLike) {
  if (e.shiftKey) return true;
  if (typeof window === "undefined") return true;
  if ((window.getSelection?.()?.toString() ?? "").trim()) return true;
  const target = e.target as { closest?: (s: string) => unknown } | null;
  return !!target?.closest?.("a[href], input, textarea, [contenteditable=true]");
}

/**
 * `bind(items)` returns the props to spread on a Pressable or View; `menu` is the element to render once.
 * `items` may be a function so it reads state at the moment of the click.
 */
export function useContextMenu() {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [supported] = useState(contextMenuSupported);
  const close = useCallback(() => setOpened(null), []);
  const bind = useCallback((items: ContextMenuItem[] | (() => ContextMenuItem[])) => {
    if (!supported) return {};
    return {
      onContextMenu: (e: MouseLike) => {
        if (keepsBrowserMenu(e)) return;
        const list = typeof items === "function" ? items() : items;
        if (!list.some(item => "label" in item)) return;
        e.preventDefault();
        e.stopPropagation?.();
        const x = e.clientX ?? e.nativeEvent?.clientX ?? e.nativeEvent?.pageX ?? 0;
        const y = e.clientY ?? e.nativeEvent?.clientY ?? e.nativeEvent?.pageY ?? 0;
        setOpened({ x, y, items: list });
      },
    } as object;
  }, [supported]);
  const menu = opened ? <ContextMenuView opened={opened} onClose={close} /> : null;
  return { bind, menu, open: opened !== null, close };
}

function ContextMenuView({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const [size, setSize] = useState({ w: MENU_WIDTH, h: 0 });
  const refs = useRef<unknown[]>([]);
  const actions = opened.items.map((item, i) => ("label" in item ? i : -1)).filter(i => i >= 0);
  const focus = (index: number) => (refs.current[index] as { focus?: () => void } | null)?.focus?.();
  // The menu itself takes focus, like a native one: nothing looks picked until the pointer or an arrow key moves.
  const menuRef = useRef<{ focus?: () => void } | null>(null);
  useEffect(() => { if (size.h) menuRef.current?.focus?.(); }, [size.h > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opens down and to the right of the pointer, and flips when that would leave the window.
  const left = Math.max(space.xs, opened.x + size.w + space.xs > width ? opened.x - size.w : opened.x);
  const top = Math.max(space.xs, opened.y + size.h + space.xs > height ? Math.max(space.xs, opened.y - size.h) : opened.y);
  const onKeyDown = (e: { key: string; preventDefault: () => void }) => {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const at = actions.findIndex(i => refs.current[i] === active);
    const move = (to: number) => { e.preventDefault(); focus(actions[(to + actions.length) % actions.length]!); };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? actions.length - 1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(actions.length - 1);
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  };
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable testID="context-menu-dismiss" accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={onClose}
        {...({ onContextMenu: (e: MouseLike) => { e.preventDefault(); onClose(); } } as object)} />
      <View ref={menuRef as never} testID="context-menu" role="menu" tabIndex={-1} onLayout={e => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        style={[styles.menu, { left, top, opacity: size.h ? 1 : 0 }]} {...({ onKeyDown } as object)}>
        {opened.items.map((item, i) => {
          if ("separator" in item) return <View key={`sep-${i}`} style={styles.separator} />;
          if ("row" in item) return <View key={item.key} style={styles.custom}>{item.row}</View>;
          return (
            <Pressable key={item.label} ref={node => { refs.current[i] = node; }} role="menuitem" accessibilityLabel={item.label}
              onPress={() => { onClose(); item.onPress(); }}
              style={state => [styles.item, ((state as { hovered?: boolean; focused?: boolean }).hovered || (state as { focused?: boolean }).focused) && styles.itemActive]}>
              <Text style={[styles.label, item.destructive && { color: colors.red }]}>{item.label}</Text>
              {item.hint ? <Text style={styles.hint}>{item.hint}</Text> : null}
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  menu: { position: "absolute", width: MENU_WIDTH, paddingVertical: space.xs, outlineStyle: "none", backgroundColor: colors.background, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, boxShadow: `0 10px 28px -6px ${colors.scrim}` } as object,
  item: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.xxs, paddingHorizontal: space.sm, marginHorizontal: space.xxs, borderRadius: radius.sm, outlineStyle: "none" } as object,
  itemActive: { backgroundColor: colors.subtle },
  label: { ...typography.body, color: colors.ink, flex: 1 },
  hint: { ...typography.meta, color: colors.muted },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.xxs },
  custom: { paddingHorizontal: space.xs, paddingVertical: space.xxs },
}));
