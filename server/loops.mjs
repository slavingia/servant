// Loops: the agent's recurring automations, shown to everyone on the server. The agent's own
// scheduler (Hermes cron) is the source. Only what a person needs to see leaves the server: a plain
// name, how often it runs, whether it is on, and when it last ran and runs next. Never the prompt,
// script, folder, model or where results are delivered.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour, minute) {
  const h = Number(hour), m = Number(minute);
  const suffix = h >= 12 ? "pm" : "am";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${twelve}${suffix}` : `${twelve}:${String(m).padStart(2, "0")}${suffix}`;
}

const ordinal = n => { const v = n % 100; return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"}`; };

/** "Every hour", "Every day at 7am", "Every 15 minutes": a cron schedule in plain words. */
export function describeCadence(schedule) {
  const kind = schedule?.kind;
  const expr = String(schedule?.expr ?? schedule?.display ?? "").trim();
  if (kind === "once") return "Once";
  if (kind === "interval" || /^every\s/i.test(expr)) {
    const minutes = Number(schedule?.minutes) || (() => {
      const m = /every\s+(\d+)\s*(m|min|minutes?|h|hours?)/i.exec(expr);
      return m ? Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1) : 0;
    })();
    if (!minutes) return "On a schedule";
    if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
    return `Every ${minutes} minutes`;
  }
  const f = expr.split(/\s+/);
  if (f.length !== 5) return "On a schedule";
  const [min, hour, dom, mon, dow] = f;
  const step = /^\*\/(\d+)$/;
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min === "*") return "Every minute";
    if (step.test(min)) return `Every ${step.exec(min)[1]} minutes`;
    if (/^\d+$/.test(min)) return "Every hour";
  }
  if (/^\d+$/.test(min) && step.test(hour) && dom === "*" && mon === "*" && dow === "*") return `Every ${step.exec(hour)[1]} hours`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && mon === "*") {
    if (dom === "*" && dow === "*") return `Every day at ${clock(hour, min)}`;
    if (dom === "*" && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow) % 7]} at ${clock(hour, min)}`;
    if (/^\d+$/.test(dom) && dow === "*") return `Monthly on the ${ordinal(Number(dom))} at ${clock(hour, min)}`;
  }
  return "On a schedule";
}

/** Cadence bucket for grouping: hourly, daily, weekly, monthly, other. */
export function cadenceGroup(label) {
  if (/^Every (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/.test(label)) return "weekly";
  if (/^Monthly/.test(label)) return "monthly";
  if (/minute|hour/i.test(label)) return "hourly";
  if (/^Every (\d+ )?days?\b/.test(label)) return "daily";
  return "other";
}

const text = value => (typeof value === "string" ? value.trim() : "");
const when = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : null; };

/** Hermes cron jobs → the list people see. Paused jobs are listed as paused; the rest are on. */
export function shapeLoops(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter(job => job && typeof job === "object" && text(job.name)).map(job => {
    const cadence = describeCadence(job.schedule ?? { display: job.schedule_display });
    const on = job.enabled !== false && job.state !== "paused";
    return {
      id: text(job.id || job.job_id) || text(job.name),
      name: text(job.name).replace(/\s*\([^)]*\)\s*$/, "").slice(0, 120),
      cadence,
      group: cadenceGroup(cadence),
      on,
      lastRunAt: when(job.last_run_at),
      lastOk: job.last_run_at ? job.last_status ? job.last_status === "ok" : null : null,
      nextRunAt: on ? when(job.next_run_at) : null,
    };
  }).sort((a, b) => (Number(b.on) - Number(a.on)) || a.name.localeCompare(b.name));
}
