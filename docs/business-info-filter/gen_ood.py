"""Independent out-of-distribution test set: a different model (Fable 5.2), different prompt wording, personas instead of styles.
Never used for training or model selection."""
import json, os, subprocess, concurrent.futures as cf
from taxonomy import CATEGORIES

M = "claude-fable-5-2"
os.makedirs("data/ood", exist_ok=True)
PERSONAS = ["a contracting officer's representative", "a junior developer on a federal modernization contract",
            "a program analyst who writes fast and sloppy", "a help-desk lead", "a CISO's chief of staff", "an HR specialist",
            "a budget analyst", "a vendor account manager", "a revenue agent", "a paralegal", "a grants manager",
            "a data engineer pasting logs"]


def pos_prompt(cat, n, persona):
    return f"""You are helping build an evaluation set for a filter that warns before sensitive business information is pasted into a workplace chat.
Write {n} short, realistic messages from {persona}. Each one must contain real-looking, specific, non-public information of this kind, as people actually paste it (not a toy example):
{cat}: {CATEGORIES[cat]}
Everything must be fabricated (invented names, invented secrets, invented figures). Vary the format a lot: emails, logs, tables, bullet lists, chat fragments, config files, questions. Some should be messy.
Output ONLY a JSON array of {n} strings."""


def neg_prompt(n, persona, hard):
    extra = ("Make them HARD: mention topics near sensitive ones (budgets, contracts, passwords, vulnerabilities, audits, salaries, tax returns) "
             "but only in public, generic, hypothetical or conceptual ways, or with clearly fake placeholder values.") if hard else \
            "Make them ordinary day-to-day messages, including some with lots of numbers or code."
    return f"""You are helping build an evaluation set for a filter that warns before sensitive business information is pasted into a workplace chat.
Write {n} short, realistic messages from {persona} that contain NO sensitive or non-public information at all. {extra}
Output ONLY a JSON array of {n} strings."""


jobs = []
for i, c in enumerate(CATEGORIES):
    for k in range(2):
        jobs.append((f"pos_{c}_{k}", pos_prompt(c, 25, PERSONAS[(i * 2 + k) % len(PERSONAS)]), [c]))
for k in range(8):
    jobs.append((f"neg_{k}", neg_prompt(25, PERSONAS[(k * 3) % len(PERSONAS)], hard=k % 2 == 0), []))


def run(j):
    jid, pr, labs = j
    path = f"data/ood/{jid}.json"
    if os.path.exists(path):
        return jid, 0, "cached"
    err = ""
    for _ in range(3):
        try:
            r = subprocess.run(["claude", "-p", pr, "--model", M, "--max-turns", "1", "--output-format", "json"],
                               capture_output=True, text=True, timeout=900, cwd="/tmp")
            d = json.loads(r.stdout)
            t = d["result"].strip()
            if t.startswith("```"):
                t = t.split("\n", 1)[1].rsplit("```", 1)[0]
            items = [x if isinstance(x, str) else x.get("text", "") for x in json.loads(t)]
            json.dump({"labels": labs, "items": items, "cost": d.get("total_cost_usd", 0),
                       "model": list((d.get("modelUsage") or {}).keys())}, open(path, "w"))
            return jid, d.get("total_cost_usd", 0), str(len(items))
        except Exception as e:
            err = str(e)[:100]
    return jid, 0, "FAILED " + err


tot = 0
with cf.ThreadPoolExecutor(6) as ex:
    for jid, c, m in ex.map(run, jobs):
        tot += c
        print(jid, m, f"${c:.2f} total ${tot:.2f}", flush=True)
print("DONE")
