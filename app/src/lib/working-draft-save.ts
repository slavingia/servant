// The whole "Save working draft" handler, independent of the screen so it can
// be tested end to end: final problems check, a recheck of the chosen
// prototype against the live library, a revision check after every await,
// building the file and saving it. Nothing is saved if anything fails or the
// plan changed while it was being checked.
import {
  buildResearchStudioWorkingCopy,
  recheckStudyPrototype,
  researchStudioFileName,
  studyDraftProblems,
  type StudyDraftInput,
} from "./research-methods.ts";

export type WorkingDraftForm = StudyDraftInput & { background?: string; prototypeId?: string | null };
export type SaveResult =
  | { ok: true; fileName: string; prototypeUrl?: string; prototypeId?: string }
  | { ok: false; reason: "problems" | "check_failed" | "prototype" | "changed" | "save_failed"; message: string; clearPrototype?: boolean };

/** Everything the saved file depends on. Any change between start and save aborts it. */
export function draftRevision(form: WorkingDraftForm): string {
  return JSON.stringify([form.title, form.decision, form.question, form.participants, form.background, form.setup, form.activities, form.otherMethods ?? [], form.prototype, form.prototypeId ?? null]);
}

export async function saveWorkingDraft<P extends { id: string; previewUrl?: string | null }>({ current, loadReadyPrototypes, save }: {
  /** The form as it is now (read again after every await). */
  current: () => WorkingDraftForm;
  /** The live list of ready prototypes (published, with a live preview). */
  loadReadyPrototypes: () => Promise<readonly P[]>;
  save: (fileName: string, text: string) => Promise<void>;
}): Promise<SaveResult> {
  const form = current();
  const revision = draftRevision(form);
  const changed = () => draftRevision(current()) !== revision;
  const changedResult: SaveResult = { ok: false, reason: "changed", message: "The plan changed while it was being checked, so the working draft wasn't saved. Save again." };
  if (studyDraftProblems(form).length) return { ok: false, reason: "problems", message: "Fix the items listed above, then save again." };
  let prototypeUrl: string | undefined;
  let prototypeId: string | undefined;
  if (form.prototype?.mode === "existing") {
    if (!form.prototypeId) return { ok: false, reason: "prototype", message: "Choose an existing prototype, or select No prototype." };
    let ready: readonly P[];
    try { ready = await loadReadyPrototypes(); }
    catch (error) {
      return { ok: false, reason: "check_failed", message: `${error instanceof Error && error.message ? `${error.message} ` : ""}The chosen prototype couldn't be checked, so the working draft wasn't saved. Try again.` };
    }
    if (changed()) return changedResult;
    const checked = recheckStudyPrototype(form.prototypeId, ready);
    if (!checked.ok) return { ok: false, reason: "prototype", message: checked.message, clearPrototype: true };
    if (studyDraftProblems({ ...form, prototype: { mode: "existing", url: checked.url } }).length) {
      return { ok: false, reason: "prototype", message: "The chosen prototype changed, so the working draft wasn't saved. Review the items above and try again." };
    }
    prototypeUrl = checked.url;
    prototypeId = checked.prototype.id;
  }
  const file = buildResearchStudioWorkingCopy({ title: form.title, decision: form.decision, question: form.question, participants: form.participants, background: form.background,
    setup: form.setup, activities: form.activities, otherMethods: form.otherMethods ?? [], prototypeUrl });
  const fileName = researchStudioFileName(form.title);
  if (changed()) return changedResult;
  try { await save(fileName, `${JSON.stringify(file, null, 2)}\n`); }
  catch (error) { return { ok: false, reason: "save_failed", message: error instanceof Error ? error.message : "Couldn't save the file. Try again." }; }
  return { ok: true, fileName, ...(prototypeUrl ? { prototypeUrl, prototypeId } : {}) };
}
