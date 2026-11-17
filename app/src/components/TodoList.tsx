import { createElement, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { router, Stack } from "expo-router";
import { AppIcon } from "./AppIcon";
import { Button, ButtonGroup, IconButton } from "./Button";
import { CheckBox } from "./CheckBox";
import { ReorderableList } from "./ReorderableList";
import { refreshProjects, useProjects } from "../lib/projects-store";
import { api, ServerError, type Account, type Conversation, type TodoComment, type TodoItem, type TodoPatch, type TodoPriority, type TodoStage, type TodoType } from "../lib/server";
import { DATE_SHAPE, orderReleases, releaseDate } from "../lib/releases";
import { boardColumns, columnPoints, dueLine, editableTodos, mergeTodoUpdates, PRIORITY_LABEL, SORT_LABEL, sortColumn, sortTodos, STAGE_LABEL, TODO_PRIORITIES, TODO_STAGES, TODO_TYPES, todoCountLine, todoMeta, todoStage, trackerMeta, TYPE_LABEL, type BoardSort } from "../lib/todo-list";
import { savedWorkLabel } from "../lib/saved-report";
import { radius, space, typography, useTheme, createThemedStyles, linkUnderline } from "../lib/theme";

// A list of to-dos you can work, kept as plain as a list on paper: a box to tick and the words. Tap the words to
// edit them in place; only then does that row offer what else can be done with it (send it to Agent, its details).
// Hold a row and drag to reorder. Everything about the list as a whole (filters, tagging several, sending all) is
// behind one icon at the top. Used under a recording's notes and on its own screen.
//
// On its own screen it is a board: To do, In progress and Done. In a wide window the three columns sit side by side
// and a card is dragged from one to another; on a phone one column shows at a time and the row being edited offers
// the move. Ticking the box is always Done. A line says when a to-do is due: its own day, or its release's.
type Props = {
  account: Account;
  todos: TodoItem[];
  /** Apply a change to the latest full list for this screen. */
  onChange: (change: (current: TodoItem[]) => TodoItem[]) => void;
  /** Pause and invalidate parent reads while this list writes, then refresh after the write. */
  onBusyChange?: (busy: boolean) => void;
  /** Re-read from the server (the agent may have finished something). */
  onReload?: () => void;
  empty?: string;
  allowAdd?: boolean;
  /** The screen's filters, shown at the top of the list's options. */
  filters?: ReactNode;
  /** Which filters are on, in a few words ("Mine · Example app"), said beside the count. */
  filterSummary?: string;
  /** Lay the to-dos out as a board of To do, In progress and Done. */
  board?: boolean;
};
// Three columns need this much room; below it the board shows one column at a time.
const BOARD_MIN_WIDTH = 720;
// The Done column grows for ever; it starts with the latest few.
const DONE_SHOWN = 10;
const EMPTY_COLUMN: Record<TodoStage, string> = { todo: "Nothing to do", doing: "Nothing in progress", done: "Nothing done yet" };
// What a dragged card carries: the to-do's id, under a name of its own so a column ignores dragged text and files.
const CARD = "application/x-servant-todo";
type DragEvent = { preventDefault(): void; dataTransfer?: { setData(type: string, value: string): void; getData(type: string): string; types: readonly string[]; effectAllowed: string; dropEffect: string } | null; currentTarget: { contains(node: unknown): boolean }; relatedTarget?: unknown };

// In a browser, pressing the mouse on a row's options would take focus from the words being edited, which ends the
// edit and removes the options before the click lands. Keeping the press from moving focus leaves both in place.
const KEEP_EDITING = (Platform.OS === "web" ? { onMouseDown: (event: { preventDefault(): void }) => event.preventDefault() } : {}) as object;

export function TodoList({ account, todos, onChange, onBusyChange, onReload, empty = "Nothing to do", allowAdd = true, filters, filterSummary = "", board = false }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  // The row whose words are being edited in place, and what its field holds.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [words, setWords] = useState("");
  // The row whose details sheet is open.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lifted, setLifted] = useState(false);
  const [draft, setDraft] = useState("");
  // The board: the column a phone is showing, whether the columns fit side by side, where a dragged card is
  // hovering, and whether the whole Done column is listed.
  const [shown, setShown] = useState<TodoStage>("todo");
  const [boardWidth, setBoardWidth] = useState(useWindowDimensions().width);
  const [over, setOver] = useState<TodoStage | null>(null);
  const [allDone, setAllDone] = useState(false);
  // How the open columns are ordered: as dragged, by priority, or by due date.
  const [sort, setSort] = useState<BoardSort>("manual");
  const sideBySide = board && boardWidth >= BOARD_MIN_WIDTH;
  // Dragging between columns is the browser's own drag and drop, so it is for the web and Mac apps with a mouse.
  const canDrag = sideBySide && Platform.OS === "web";
  const running = useRef(false);
  const mounted = useRef(true);
  const adder = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const ordered = useMemo(() => sortTodos(todos), [todos]);
  const open = ordered.filter(t => t.status === "open");
  const done = ordered.filter(t => t.status === "done");
  const columns = useMemo(() => boardColumns(todos), [todos]);
  const editableOpen = editableTodos(open);
  const sendable = editableOpen.filter(t => !t.chatId);
  const selected = editableTodos(todos).filter(t => picked.includes(t.id));
  const editing = todos.find(t => t.id === editingId && t.canEdit) ?? null;
  useEffect(() => {
    // Permissions and visibility are server-controlled. Conceal immediately during render,
    // then dismiss the editor so a later grant does not reopen an old private draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (editingId && !editing) setEditingId(null);
  }, [editingId, editing]);
  useEffect(() => {
    const allowed = new Set(todos.filter(t => t.canEdit).map(t => t.id));
    // Remove selections whose visibility or editing permission was revoked.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPicked(current => current.every(id => allowed.has(id)) ? current : current.filter(id => allowed.has(id)));
  }, [todos]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (bulk && !selected.length) setBulk(false);
  }, [bulk, selected.length]);
  const writeBusy = (id: string, value: boolean) => {
    running.current = value;
    if (!mounted.current) return;
    setBusy(value ? id : null);
    onBusyChange?.(value);
  };
  const replace = (next: TodoItem | TodoItem[]) => {
    const list = Array.isArray(next) ? next : [next];
    if (mounted.current) onChange(current => mergeTodoUpdates(current, list));
  };
  const fail = (e: unknown, fallback: string) => setError(e instanceof ServerError ? e.message : fallback);
  const run = async <T,>(id: string, work: () => Promise<T>, fallback: string, accept?: (value: T) => void, rethrow = false): Promise<T | null> => {
    if (running.current) return null;
    writeBusy(id, true); setError(null);
    try {
      const value = await work();
      if (!mounted.current) return null;
      accept?.(value);
      return value;
    } catch (e) {
      if (rethrow) throw e;
      if (mounted.current) fail(e, fallback);
      return null;
    } finally { writeBusy(id, false); }
  };

  const tick = async (t: TodoItem) => {
    await run(t.id, () => api.updateTodo(account, t.id, { status: t.status === "done" ? "open" : "done" }), "Couldn't save that. Try again", next => replace(next.todo));
  };
  // Move a card to another column. To do and In progress are both open; Done is the same as ticking the box.
  const move = async (t: TodoItem, stage: TodoStage) => {
    setActiveId(null);
    if (todoStage(t) === stage) return;
    await run(t.id, () => api.updateTodo(account, t.id, { stage }), "Couldn't move that. Try again", next => replace(next.todo));
  };
  // Leaving a row's words (a tap elsewhere, or Return) saves them if they changed, and puts its options away.
  const finishWords = async (t: TodoItem) => {
    const next = words.trim();
    setActiveId(current => current === t.id ? null : current);
    if (!next || next === t.text) return;
    await run(t.id, () => api.updateTodo(account, t.id, { text: next }), "Couldn't save that. Try again", r => replace(r.todo));
  };
  const send = async (t: TodoItem) => {
    setActiveId(null);
    const sent = await run(t.id, () => api.sendTodoToAgent(account, t.id), "Couldn't start the agent. Try again", next => replace(next.todo));
    if (!sent) return;
    if (sent.chatId && sent.started) router.push({ pathname: "/chat/[id]", params: { id: sent.chatId, title: t.text } });
  };
  const sendAll = async () => {
    await run("all", async () => {
      for (const t of sendable) {
        if (!mounted.current) break;
        const result = await api.sendTodoToAgent(account, t.id);
        replace(result.todo);
      }
    }, "Couldn't start the agent. Try again");
  };
  const drop = async (ids: string[], group: TodoItem[] = open) => {
    if (editableOpen.length !== open.length) return;
    // Only the open ones of one list or column are dragged; the rest stay where they are.
    const positions = new Map(todos.map(t => [t.id, t.position]));
    await run("order", async () => {
      onChange(current => sortTodos(current.map(t => { const i = ids.indexOf(t.id); return i < 0 ? t : { ...t, position: Math.min(...group.map(o => o.position)) + i / 1000 }; })));
      try { replace((await api.reorderTodos(account, ids)).todos); }
      catch (e) { onChange(current => sortTodos(current.map(t => ({ ...t, position: positions.get(t.id) ?? t.position })))); throw e; }
    }, "Couldn't save the new order");
  };
  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    // The line stays ready for the next one, as on a paper list.
    await run("add", () => api.addTodo(account, { text }), "Couldn't add that. Try again", r => { setDraft(""); onChange(current => sortTodos([...current, r.todo])); });
    adder.current?.focus();
  };
  const applyBulk = async (patch: TodoPatch) => {
    if (!selected.length) throw new Error("Choose a to-do you can edit.");
    await run("bulk", () => api.bulkTodos(account, selected.map(t => t.id), patch), "Couldn't change those. Try again", r => { replace(r.todos); setBulk(false); setSelecting(false); setPicked([]); }, true);
  };

  const row = (t: TodoItem, bind?: Parameters<NonNullable<React.ComponentProps<typeof ReorderableList<TodoItem>>["renderRow"]>>[1]) => {
    const on = picked.includes(t.id);
    const finished = t.status === "done";
    const active = activeId === t.id && !selecting && t.canEdit;
    const meta = todoMeta(t);
    const due = dueLine(t);
    const stage = todoStage(t);
    const tracker = board ? trackerMeta(t) : { lead: "", tail: "" };
    const line = (
      <View key={t.id} testID={`todo-${t.id}`} style={[styles.row, finished && styles.rowDone, bind?.lifted && styles.rowLifted]}>
        {selecting ? (
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !t.canEdit || !!busy }} aria-checked={on} accessibilityLabel={`Choose: ${t.text}`} disabled={!t.canEdit || !!busy}
            onPress={() => setPicked(p => on ? p.filter(x => x !== t.id) : [...p, t.id])} style={styles.boxTarget}>
            <CheckBox on={on} />
          </Pressable>
        ) : (
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: finished, disabled: !t.canEdit || !!busy }} aria-checked={finished} accessibilityLabel={`${finished ? "Done" : "Not done"}: ${t.text}. Tap to ${finished ? "reopen" : "mark done"}`}
            disabled={!t.canEdit || !!busy} onPress={() => void tick(t)} style={styles.boxTarget}>
            <CheckBox on={finished} tone="done" busy={busy === t.id} />
          </Pressable>
        )}
        {active ? (
          <View style={styles.body}>
            <TextInput testID="todo-words" accessibilityLabel="What needs doing" autoFocus multiline value={words} onChangeText={setWords} maxLength={300}
              submitBehavior="blurAndSubmit" blurOnSubmit returnKeyType="done" onSubmitEditing={() => void finishWords(t)} onBlur={() => void finishWords(t)}
              // In a browser Return in a field of several lines would start a new line: here it finishes the edit.
              onKeyPress={event => { if (event.nativeEvent.key === "Enter" && !(event.nativeEvent as { shiftKey?: boolean }).shiftKey) { event.preventDefault(); void finishWords(t); } }}
              cursorColor={colors.ink} style={styles.words} />
            {/* What else can be done with this one, offered only while it is the one being worked on. */}
            <View testID="todo-options" style={styles.options} {...KEEP_EDITING}>
              <ButtonGroup>
                {finished ? null : t.chatId
                  ? <Button label="Open chat" kind="link" compact onPress={() => { setActiveId(null); router.push({ pathname: "/chat/[id]", params: { id: t.chatId!, title: t.text } }); }} />
                  : <Button label="Send to Agent" kind="link" compact onPress={() => void send(t)} />}
                {/* On a phone there is no dragging: the row being worked on offers the move. */}
                {board && !finished ? <Button label={stage === "doing" ? "Move to To do" : "Start"} accessibilityLabel={stage === "doing" ? `Move to To do: ${t.text}` : `Start: ${t.text}`} kind="link" compact onPress={() => void move(t, stage === "doing" ? "todo" : "doing")} /> : null}
                <Button label="Details" accessibilityLabel={`Details of: ${t.text}`} kind="link" compact onPress={() => { setActiveId(null); setEditingId(t.id); }} />
              </ButtonGroup>
            </View>
          </View>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel={`${t.text}. Edit`} accessibilityActions={bind?.accessibilityActions} onAccessibilityAction={bind?.onAccessibilityAction}
            disabled={!t.canEdit || !!busy} onPress={() => { if (selecting) setPicked(p => on ? p.filter(x => x !== t.id) : [...p, t.id]); else { setWords(t.text); setActiveId(t.id); } }}
            onLongPress={bind && !finished && !selecting && t.canEdit ? bind.onLongPress : undefined} delayLongPress={350} style={styles.body}>
            <Text style={[styles.text, finished && styles.textDone]}>{t.text}</Text>
            {/* One quiet line: on the board its key and what kind of work it is, then when it is due, who it is for and where it belongs. */}
            {tracker.lead || due || meta || tracker.tail ? <Text style={styles.meta}>
              {tracker.lead ? <Text testID="todo-key">{tracker.lead}</Text> : null}{tracker.lead && (due || meta || tracker.tail) ? " · " : ""}
              {due ? <Text testID="todo-due" style={due.overdue ? styles.overdue : undefined}>{due.text}</Text> : null}{due && (meta || tracker.tail) ? " · " : ""}
              {meta}{meta && tracker.tail ? " · " : ""}{tracker.tail}
            </Text> : null}
          </Pressable>
        )}
      </View>
    );
    if (!canDrag || !t.canEdit || selecting || active || !!busy) return line;
    // A card is picked up with the mouse and dropped on another column.
    return createElement("div", {
      key: t.id, draggable: true, style: { display: "flex", flexDirection: "column", cursor: "grab" },
      onDragStart: (event: DragEvent) => { if (event.dataTransfer) { event.dataTransfer.setData(CARD, t.id); event.dataTransfer.effectAllowed = "move"; } },
      onDragEnd: () => setOver(null),
    }, line);
  };

  // Hold and drag reorders the open to-dos of a list or a column, except where a mouse drags cards between columns.
  const still = selecting || editableOpen.length !== open.length || !!busy || !!activeId || canDrag || (board && sort !== "manual");
  // The next line of the list: no box around it, no button beside it. Return adds it and waits for another.
  const adderLine = !selecting && allowAdd ? (
    <View style={styles.row}>
      <View style={styles.boxTarget}><AppIcon name="plus" size={18} color={colors.muted} /></View>
      <TextInput ref={adder} testID="todo-add" accessibilityLabel="New to-do" editable={!busy} placeholder="New to-do" placeholderTextColor={colors.muted} value={draft} onChangeText={setDraft}
        onSubmitEditing={() => void add()} onBlur={() => void add()} blurOnSubmit={false} returnKeyType="done" maxLength={300} cursorColor={colors.ink} style={[styles.words, styles.adder]} />
    </View>
  ) : null;
  // The board counts in its columns, so the line above it only says which filters are on.
  const count = board ? filterSummary : todoCountLine(open.length, done.length, filterSummary);
  const canChoose = editableOpen.length > 1;
  const hasMenu = !!filters || canChoose || sendable.length > 1;
  const openMenu = () => { setActiveId(null); setMenu(true); };
  const menuLabel = filters ? "Filter and options" : "Options";
  const menuButton = hasMenu && !selecting ? <IconButton testID="todo-menu" icon="sort" label={menuLabel} edge={board ? undefined : "end"} disabled={!!busy} onPress={openMenu} /> : null;
  return (
    <View>
      {/* On the board the options button is in the screen's header: the system's own button on iOS, ours elsewhere. */}
      {board ? <Stack.Screen options={!menuButton ? { headerRight: undefined, unstable_headerRightItems: undefined } : Platform.OS === "ios"
        ? { unstable_headerRightItems: () => [{ type: "button" as const, label: menuLabel, accessibilityLabel: menuLabel, icon: { type: "sfSymbol" as const, name: "line.3.horizontal.decrease" }, tintColor: colors.blue, hidesSharedBackground: true, onPress: openMenu }] }
        : { headerRight: () => <View style={styles.headerMenu}>{menuButton}</View> }} /> : null}
      {selecting ? (
        <View style={styles.bulkBar}>
          <Pressable accessibilityRole="button" disabled={!!busy} onPress={() => setPicked(selected.length === editableOpen.length ? [] : editableOpen.map(t => t.id))} style={styles.linkTarget}><Text style={styles.link}>{selected.length === editableOpen.length ? "Choose none" : "Choose all"}</Text></Pressable>
          <ButtonGroup align="end">
            <Button label={selected.length ? `Tag ${selected.length}` : "Tag"} compact disabled={!selected.length || !!busy} onPress={() => setBulk(true)} />
            <Button label="Done" kind="secondary" compact disabled={!!busy} onPress={() => { setSelecting(false); setPicked([]); }} />
          </ButtonGroup>
        </View>
      ) : board ? (
        // The board's options are in the screen's header, top right, so nothing but the board is on the screen.
        count ? <Text testID="todo-count" style={styles.boardFilters}>{count}</Text> : null
      ) : count || hasMenu ? (
        <View style={styles.toolbar}>
          <Text testID="todo-count" style={styles.count}>{count}</Text>
          {menuButton}
        </View>
      ) : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {board ? (
        <View testID="todo-board" onLayout={event => setBoardWidth(event.nativeEvent.layout.width)}>
          {sideBySide ? null : <View style={styles.boardBar}>
            {/* One column at a time where three do not fit: the three names, each with how many it holds. */}
            <View accessibilityRole="radiogroup" accessibilityLabel="Column" style={styles.segments}>
              {TODO_STAGES.map(stage => {
                const on = shown === stage;
                return (
                  <Pressable key={stage} testID={`todo-segment-${stage}`} accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on} accessibilityLabel={`${STAGE_LABEL[stage]}, ${columns[stage].length}`}
                    onPress={() => { setActiveId(null); setShown(stage); }} style={[styles.segment, on && styles.segmentOn]}>
                    <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{STAGE_LABEL[stage]} {columns[stage].length}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>}
          <View style={sideBySide ? styles.board : undefined}>{(sideBySide ? TODO_STAGES : [shown]).map(stage => {
            const items = stage === "done" ? columns[stage] : sortColumn(columns[stage], sort);
            const points = columnPoints(items);
            const listed = stage === "done" && !allDone ? items.slice(0, DONE_SHOWN) : items;
            const inside = <>
              {sideBySide ? <View style={styles.columnHead}><Text accessibilityRole="header" style={styles.columnTitle}>{STAGE_LABEL[stage]}</Text><Text style={styles.columnCount}>{items.length}{points ? ` · ${points}` : ""}</Text></View> : null}
              {stage === "done" ? listed.map(t => row(t)) : !items.length ? null : still ? items.map(t => row(t)) : <ReorderableList items={items} onLift={() => setLifted(true)} onSettle={() => setLifted(false)} onDrop={ids => void drop(ids, items)} renderRow={(t, bind) => row(t, bind)} />}
              {!todos.length && stage === "todo" ? <Text style={styles.empty}>{empty}</Text>
                : !items.length && !(stage === "todo" && adderLine) ? <Text style={styles.empty}>{EMPTY_COLUMN[stage]}</Text> : null}
              {stage === "todo" ? adderLine : null}
              {items.length > listed.length ? <Button label={`Show all ${items.length}`} kind="link" compact onPress={() => setAllDone(true)} /> : null}
            </>;
            if (!canDrag) return <View key={stage} testID={`todo-column-${stage}`} style={sideBySide ? styles.column : undefined}>{inside}</View>;
            // A column takes a dropped card.
            return <DropColumn key={stage} stage={stage} over={over === stage} onOver={on => setOver(current => on ? stage : current === stage ? null : current)}
              onCard={id => { const card = todos.find(t => t.id === id && t.canEdit); if (card) void move(card, stage); }}>{inside}</DropColumn>;
          })}</View>
        </View>
      ) : <>
        {open.length ? (still ? open.map(t => row(t)) : <ReorderableList items={open} onLift={() => setLifted(true)} onSettle={() => setLifted(false)} onDrop={ids => void drop(ids)} renderRow={(t, bind) => row(t, bind)} />) : !done.length ? <Text style={styles.empty}>{empty}</Text> : null}
        {adderLine}
        {done.length ? <View>{open.length || allowAdd ? <Text style={styles.divider}>Done</Text> : null}{done.map(t => row(t))}</View> : null}
      </>}
      {menu ? (
        <Modal transparent animationType="slide" onRequestClose={() => setMenu(false)}>
          <View style={styles.sheetWrap}>
            <Pressable accessibilityLabel="Close" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={() => setMenu(false)} />
            <View testID="todo-menu-sheet" accessibilityViewIsModal style={styles.sheet}>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
                {filters}
                {board ? <>
                  <Text style={styles.label}>Sort To do and In progress by</Text>
                  <View accessibilityRole="radiogroup" accessibilityLabel="Sort by" style={styles.choices}>
                    {(Object.keys(SORT_LABEL) as BoardSort[]).map(by => <Option key={by} label={SORT_LABEL[by]} on={sort === by} onPress={() => setSort(by)} />)}
                  </View>
                </> : null}
                {canChoose || sendable.length > 1 ? <View style={styles.menuActions}>
                  {canChoose ? <Button label="Tag several" kind="secondary" onPress={() => { setMenu(false); setSelecting(true); setPicked([]); }} /> : null}
                  {sendable.length > 1 ? <Button label={`Send all ${sendable.length} to Agent`} kind="secondary" disabled={!!busy || lifted} onPress={() => { setMenu(false); void sendAll(); }} /> : null}
                </View> : null}
              </ScrollView>
              <View style={styles.sheetButtons}>
                {onReload ? <Button label="Refresh" kind="link" compact onPress={() => { setMenu(false); onReload(); }} /> : null}
                {/* What was finished, by whom and when, is kept in the work log. */}
                {board ? <Button label="Work log" kind="link" compact onPress={() => { setMenu(false); router.push({ pathname: "/saved", params: { view: "history" } }); }} /> : null}
                <View style={{ flex: 1 }} />
                <Button label="Done" compact onPress={() => setMenu(false)} />
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
      {editing ? <TodoEditor key={editing.id} account={account} todo={editing} epics={todos.filter(t => t.type === "epic" && t.id !== editing.id)} onClose={() => setEditingId(null)} onBusyChange={value => writeBusy(editing.id, value)}
        onSaved={t => { replace(t); setEditingId(null); }}
        onDeleted={() => { onChange(current => current.filter(t => t.id !== editing.id)); setEditingId(null); }} /> : null}
      {bulk && selected.length ? <TodoEditor account={account} bulkCount={selected.length} onClose={() => setBulk(false)} onBulk={applyBulk} /> : null}
    </View>
  );
}

// A column of the board in a browser: a card dragged over it can be dropped on it, and an outline says where it will land.
function DropColumn({ stage, over, onOver, onCard, children }: { stage: TodoStage; over: boolean; onOver: (over: boolean) => void; onCard: (id: string) => void; children: ReactNode }) {
  const { colors } = useTheme();
  return createElement("div", {
    "data-testid": `todo-column-${stage}`,
    style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", borderRadius: radius.md, outline: over ? `2px solid ${colors.blue}` : "none", outlineOffset: space.xs },
    onDragOver: (event: DragEvent) => { if (!event.dataTransfer?.types.includes(CARD)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (!over) onOver(true); },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget)) onOver(false); },
    onDrop: (event: DragEvent) => { event.preventDefault(); const id = event.dataTransfer?.getData(CARD); onOver(false); if (id) onCard(id); },
  }, children);
}

// Edit one to-do, or tag several at once (bulkCount): words, who it's for, project, release and channel.
function TodoEditor({ account, todo, epics = [], bulkCount, onClose, onSaved, onDeleted, onBulk, onBusyChange }: {
  account: Account; todo?: TodoItem; epics?: TodoItem[]; bulkCount?: number; onClose: () => void;
  onSaved?: (t: TodoItem) => void; onDeleted?: () => void; onBulk?: (patch: TodoPatch) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const projects = useProjects();
  const [text, setText] = useState(todo?.text ?? "");
  const [who, setWho] = useState(todo?.assignee?.name ?? "");
  const [due, setDue] = useState(todo?.dueDate ?? "");
  // The tracker's fields: what kind of work, how much it matters, how big, a longer write-up, its epic, its Jira issue.
  const [type, setType] = useState<TodoType>(todo?.type ?? "task");
  const [priority, setPriority] = useState<TodoPriority | null>(todo?.priority ?? null);
  const [estimate, setEstimate] = useState(todo?.estimate === null || todo?.estimate === undefined ? "" : String(todo.estimate));
  const [description, setDescription] = useState(todo?.description ?? "");
  const [parentId, setParentId] = useState<string | null>(todo?.parentId ?? null);
  const [jiraKey, setJiraKey] = useState(todo?.jiraKey ?? "");
  const [comments, setComments] = useState<TodoComment[] | null>(null);
  const [remark, setRemark] = useState("");
  const [remarking, setRemarking] = useState(false);
  const todoId = todo?.id;
  useEffect(() => {
    if (!todoId) return;
    let live = true;
    api.todoComments(account, todoId).then(result => { if (live) setComments(result.comments); }).catch(() => { if (live) setComments([]); });
    return () => { live = false; };
  }, [account, todoId]);
  const addComment = async () => {
    const words = remark.trim();
    if (!todoId || !words || remarking) return;
    setRemarking(true); setError(null);
    try { const result = await api.addTodoComment(account, todoId, words); setComments(current => [...(current ?? []), result.comment]); setRemark(""); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't add the comment. Try again"); }
    finally { setRemarking(false); }
  };
  const [projectId, setProjectId] = useState<string | null>(todo?.projectId ?? null);
  const [releaseId, setReleaseId] = useState<string | null>(todo?.releaseId ?? null);
  const [channelId, setChannelId] = useState<string | null>(todo?.channelId ?? null);
  const [channels, setChannels] = useState<Conversation[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bulk = bulkCount !== undefined;
  useEffect(() => { void refreshProjects(account); }, [account]);
  useEffect(() => { api.conversations(account).then(all => setChannels(all.filter(c => c.kind === "channel" && !c.archived))).catch(() => {}); }, [account]);
  const list = projects?.list ?? [];
  const project = list.find(p => p.id === projectId) ?? null;
  // Upcoming releases first, then past ones: a to-do is usually for the next drop.
  const ordered = project ? orderReleases(project.releases) : { upcoming: [], past: [] };
  const releases = [...ordered.upcoming, ...ordered.past];
  const pickProject = (id: string | null) => { setProjectId(id); setReleaseId(null); };
  // Without a day of its own, a to-do is due with its release.
  const releaseDay = releases.find(r => r.id === releaseId)?.date ?? "";

  const save = async () => {
    if (saving) return;
    setSaving(true); setError(null); onBusyChange?.(true);
    try {
      if (bulk) {
        const patch: TodoPatch = {};
        if (projectId !== null) { patch.projectId = projectId; patch.releaseId = releaseId; }
        if (channelId !== null) patch.channelId = channelId;
        if (who.trim()) patch.assigneeName = who.trim();
        if (!Object.keys(patch).length) { setError("Choose a project, a channel or who it's for"); return; }
        await onBulk?.(patch);
      } else if (todo) {
        const dueDate = due.trim();
        if (dueDate && !DATE_SHAPE.test(dueDate)) { setError("Due dates look like 2026-11-20"); return; }
        const points = estimate.trim();
        if (points && !Number.isFinite(Number(points))) { setError("Give the estimate as a number of points, like 3"); return; }
        const r = await api.updateTodo(account, todo.id, { text, assigneeName: who.trim(), projectId, releaseId, channelId, dueDate: dueDate || null,
          type, priority, estimate: points ? Number(points) : null, description, parentId: type === "epic" ? null : parentId, jiraKey: jiraKey.trim() || null });
        onSaved?.(r.todo);
      }
    } catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't save. Try again"); }
    finally { setSaving(false); onBusyChange?.(false); }
  };
  const remove = async () => {
    if (!todo || saving) return;
    setSaving(true); onBusyChange?.(true);
    try { await api.deleteTodo(account, todo.id); onDeleted?.(); }
    catch (e) { setError(e instanceof ServerError ? e.message : "Couldn't delete that"); }
    finally { setSaving(false); onBusyChange?.(false); }
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={() => { if (!saving) onClose(); }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" disabled={saving} style={StyleSheet.absoluteFill} onPress={onClose} />
        <View accessibilityViewIsModal style={styles.sheet}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>{bulk ? `Tag ${bulkCount} to-dos` : "Edit to-do"}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
            {!bulk ? <>
              <Text style={styles.label}>What needs doing</Text>
              <TextInput accessibilityLabel="What needs doing" value={text} onChangeText={setText} multiline maxLength={300} style={[styles.input, styles.inputTall]} />
              <Text style={styles.label}>Description</Text>
              <TextInput testID="todo-description" accessibilityLabel="Description" placeholder="Background, steps, what done looks like" placeholderTextColor={colors.muted} value={description} onChangeText={setDescription} multiline maxLength={5000} style={[styles.input, styles.inputTall]} />
              <Text style={styles.label}>Type</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel="Type" style={styles.choices}>
                {TODO_TYPES.map(kind => <Option key={kind} label={TYPE_LABEL[kind]} on={type === kind} onPress={() => setType(kind)} />)}
              </View>
              {type === "epic" ? <Text style={styles.hint}>An epic is a larger piece of work that other to-dos belong to.</Text> : null}
              <Text style={styles.label}>Priority</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel="Priority" style={styles.choices}>
                <Option label="No priority" on={priority === null} onPress={() => setPriority(null)} />
                {TODO_PRIORITIES.map(level => <Option key={level} label={PRIORITY_LABEL[level]} on={priority === level} onPress={() => setPriority(level)} />)}
              </View>
              <Text style={styles.label}>Estimate (points)</Text>
              <TextInput testID="todo-estimate" accessibilityLabel="Estimate in points" placeholder="No estimate" placeholderTextColor={colors.muted} value={estimate} onChangeText={setEstimate} maxLength={6} keyboardType="decimal-pad" style={styles.input} />
            </> : <Text style={styles.hint}>Only what you choose below changes. Everything else stays as it is.</Text>}
            <Text style={styles.label}>For</Text>
            <TextInput accessibilityLabel="Who it's for" placeholder="A name, or nobody yet" placeholderTextColor={colors.muted} value={who} onChangeText={setWho} maxLength={60} style={styles.input} />
            {!bulk ? <>
              <Text style={styles.label}>Due (YYYY-MM-DD)</Text>
              <TextInput testID="todo-due-date" accessibilityLabel="Due date, year-month-day" placeholder="No date of its own" placeholderTextColor={colors.muted} value={due} onChangeText={setDue} maxLength={10} keyboardType="numbers-and-punctuation" autoCapitalize="none" autoCorrect={false} style={styles.input} />
              <Text testID="todo-due-hint" style={styles.hint}>{DATE_SHAPE.test(releaseDay) ? `Leave it empty and it is due with its release, ${releaseDate(releaseDay)}.` : "Leave it empty and it has no due date."}</Text>
            </> : null}
            <Text style={styles.label}>Project</Text>
            <View style={styles.choices}>
              {!bulk ? <Option label="No project" on={projectId === null} onPress={() => pickProject(null)} /> : null}
              {list.map(p => <Option key={p.id} label={p.name} on={projectId === p.id} onPress={() => pickProject(p.id)} />)}
            </View>
            {project ? <>
              <Text style={styles.label}>Release</Text>
              <View style={styles.choices}>
                <Option label="No release" on={releaseId === null} onPress={() => setReleaseId(null)} />
                {releases.map(r => <Option key={r.id} label={r.name} on={releaseId === r.id} onPress={() => setReleaseId(r.id)} />)}
              </View>
              {!releases.length ? <Text style={styles.hint}>This project has no releases yet. Add one on its project page.</Text> : null}
            </> : null}
            {!bulk && type !== "epic" && (epics.length || parentId) ? <>
              <Text style={styles.label}>Epic</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel="Epic" style={styles.choices}>
                <Option label="No epic" on={parentId === null} onPress={() => setParentId(null)} />
                {epics.map(epic => <Option key={epic.id} label={epic.text} on={parentId === epic.id} onPress={() => setParentId(epic.id)} />)}
              </View>
            </> : null}
            <Text style={styles.label}>Post updates to</Text>
            <View style={styles.choices}>
              {!bulk ? <Option label="No channel" on={channelId === null} onPress={() => setChannelId(null)} /> : null}
              {channels.map(c => <Option key={c.id} label={`#${c.title}`} on={channelId === c.id} onPress={() => setChannelId(c.id)} />)}
            </View>
            <Text style={styles.hint}>New, edited and finished to-dos are posted in that channel.</Text>
            {!bulk && todo ? <>
              <Text style={styles.label}>Jira issue</Text>
              <TextInput testID="todo-jira-key" accessibilityLabel="Jira issue key" placeholder="Not in Jira yet" placeholderTextColor={colors.muted} value={jiraKey} onChangeText={setJiraKey} maxLength={30} autoCapitalize="characters" autoCorrect={false} style={styles.input} />
              <Text style={styles.hint}>{todo.key} in Servant. Once it has a Jira key such as APP-42, the export updates that issue instead of making a new one.</Text>
              <Text style={styles.label}>Comments</Text>
              {comments === null ? <Text style={styles.hint}>Loading comments</Text> : !comments.length ? <Text style={styles.hint}>No comments yet.</Text> : (
                <View testID="todo-comments" style={styles.comments}>
                  {comments.map(comment => <View key={comment.id}>
                    <Text style={styles.commentBy}>{comment.author.name} · {savedWorkLabel(comment.createdAt)}</Text>
                    <Text selectable style={styles.commentText}>{comment.text}</Text>
                  </View>)}
                </View>
              )}
              <TextInput testID="todo-comment" accessibilityLabel="Add a comment" placeholder="Add a comment" placeholderTextColor={colors.muted} value={remark} onChangeText={setRemark} multiline maxLength={2000} style={[styles.input, styles.commentBox]} />
              <View style={styles.commentSend}><Button label="Add comment" kind="secondary" compact busy={remarking} disabled={!remark.trim()} onPress={() => void addComment()} /></View>
            </> : null}
          </ScrollView>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <View style={styles.sheetButtons}>
            {!bulk ? <Button label="Delete" kind="danger" compact disabled={saving} onPress={() => void remove()} /> : null}
            <View style={{ flex: 1 }} />
            <Button label="Cancel" kind="secondary" compact disabled={saving} onPress={onClose} />
            <Button label="Save" compact busy={saving} disabled={!bulk && !text.trim()} onPress={() => void save()} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Option({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on} accessibilityLabel={label} onPress={onPress} style={[styles.option, on && styles.optionOn]}><Text style={[styles.optionText, on && styles.optionTextOn]}>{label}</Text></Pressable>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  // Controls are at least 44 points by their own size: hit slop does nothing in a browser or the Mac app.
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  linkTarget: { minHeight: 44, justifyContent: "center" },
  count: { ...typography.caption, color: colors.muted, flex: 1, minWidth: 0 },
  link: { ...typography.label, color: colors.blue, ...linkUnderline },
  error: { ...typography.caption, color: colors.red, backgroundColor: colors.redSoft, padding: space.sm, borderRadius: radius.sm, marginVertical: space.xs },
  empty: { ...typography.body, color: colors.muted, paddingVertical: space.sm },
  divider: { ...typography.label, color: colors.muted, marginTop: space.lg, marginBottom: space.xxs },
  bulkBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, paddingBottom: space.xs },
  // A line of the list: a box and the words, nothing drawn between one line and the next.
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, backgroundColor: colors.background },
  rowDone: { opacity: 0.7 },
  rowLifted: { backgroundColor: colors.surface },
  // The 24-point box sits where it did; the target around it is 44 points and takes no extra room in the row.
  boxTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginHorizontal: -10 },
  body: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center", paddingVertical: space.xs },
  text: { ...typography.body, color: colors.ink },
  textDone: { textDecorationLine: "line-through", color: colors.muted },
  // Who it is for and where it belongs, as one quiet line under the words.
  meta: { ...typography.caption, color: colors.muted, marginTop: space.xxs / 2 },
  // A day that has passed is the one thing on the line that is not quiet.
  overdue: { color: colors.red },
  // The board. Side by side, each column is headed by its name and how many it holds, over a hairline.
  board: { flexDirection: "row", alignItems: "stretch", gap: space.xl },
  column: { flex: 1, minWidth: 0 },
  columnHead: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, marginBottom: space.xxs },
  headerMenu: { paddingRight: Platform.OS === "web" ? space.xs : 0 },
  boardBar: { flexDirection: "row", alignItems: "center", gap: space.xs, marginBottom: space.xs },
  boardFilters: { ...typography.caption, color: colors.muted, marginBottom: space.xs },
  columnTitle: { ...typography.label, color: colors.ink },
  columnCount: { ...typography.label, color: colors.muted },
  // One column at a time: the three names in one control, the chosen one filled.
  segments: { flexDirection: "row", gap: space.xxs, padding: space.xxs, borderRadius: radius.md, backgroundColor: colors.surface, flex: 1, minWidth: 0 },
  segment: { flex: 1, minWidth: 0, minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs, borderRadius: radius.sm },
  segmentOn: { backgroundColor: colors.background },
  segmentText: { ...typography.label, color: colors.muted, textAlign: "center" },
  segmentTextOn: { color: colors.ink },
  // The words being edited sit exactly where they were read: the same type, no box around them.
  words: { ...typography.body, color: colors.ink, padding: 0, margin: 0, borderWidth: 0, backgroundColor: "transparent", ...(Platform.OS === "web" ? { outlineStyle: "none" } as object : {}) },
  adder: { flex: 1, minWidth: 0, minHeight: 44, paddingVertical: space.xs },
  // The links sit under the words, flush with them, and close to them.
  options: { marginLeft: -space.md, marginTop: -space.xxs, marginBottom: -space.xs },
  menuActions: { gap: space.xs, marginTop: space.md },
  input: { ...controls.input, flex: 1 },
  inputTall: { minHeight: 88, textAlignVertical: "top" },
  sheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: { backgroundColor: colors.background, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.side, maxHeight: "88%" },
  sheetTitle: { ...typography.heading, color: colors.ink, marginBottom: space.sm },
  label: { ...typography.label, color: colors.muted, marginTop: space.md, marginBottom: space.xs },
  hint: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  option: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background, maxWidth: 220 },
  optionOn: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
  optionText: { ...typography.label, color: colors.ink },
  optionTextOn: { color: colors.blueDark },
  comments: { gap: space.sm, marginBottom: space.sm },
  commentBy: { ...typography.caption, color: colors.muted },
  commentText: { ...typography.body, color: colors.ink },
  commentBox: { minHeight: 64, textAlignVertical: "top" },
  commentSend: { alignItems: "flex-start", marginTop: space.xs },
  sheetButtons: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.md },
}));
