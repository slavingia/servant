import json, os, random, subprocess, sys, time, hashlib, concurrent.futures as cf
from taxonomy import CATEGORIES
OUT = os.environ.get("GEN_OUT", "data/raw"); os.makedirs(OUT, exist_ok=True)
MODEL = os.environ.get("GEN_MODEL", "claude-sonnet-5-5")

STYLES = [
 "a short message typed to an AI assistant or coworker, casual, maybe lowercase or with a typo",
 "a question that includes pasted content (an email excerpt, a config snippet, a table row, a log line)",
 "a paragraph from an email someone is about to send or forward",
 "a few lines of meeting notes or a status update pasted for summarizing",
 "a request to draft, rewrite or summarize something, with the real details included in the request",
 "a code or config paste with a short question about it",
 "a long, detailed message of 80 to 150 words",
 "a terse one-liner",
 "a message written in Spanish by a native speaker (natural, not translated-sounding)",
]
NEG_TYPES = {
 "chat": "ordinary workplace chat: scheduling, drafting a friendly note, brainstorming, summarizing public articles, wording help, translations, trivia, personal-productivity questions",
 "public_gov": "questions or notes about PUBLIC government and tax information: filing deadlines, standard deduction amounts, published government forms and publications, public program rules, published budgets and contract awards, press releases, congressional testimony already public",
 "tech_placeholder": "technical help that talks about secrets WITHOUT containing one: placeholders like <API_KEY>, YOUR_TOKEN_HERE, env var NAMES with no value, 'how do I rotate a key', masked values like ****, example.com hosts, documentation snippets",
 "concepts": "questions about the concepts: what CUI means, how to write a procurement plan, password policy best practice, how source selection works, how performance reviews are structured, what a SOC 2 audit covers, generic security hygiene",
 "public_business": "public business and security information: published earnings, public CVE discussion, vendor marketing facts, open-source code, public pricing pages, news about a breach that has been widely reported, public org charts and job postings",
 "near_miss": "HARD NEGATIVES that look close to sensitive but are not: clearly hypothetical or illustrative numbers ('say a contract of $X'), template or sample figures labelled as examples, generic salary ranges from public postings, a rounded-off public fact, discussion of the process of an investigation without specifics, an expired or revoked sample key labelled as a docs example",
 "dev": "software engineering help with no secrets or internal details: debugging, regexes, SQL, refactoring, git, tests, API design with fake placeholder data",
 "servant": "using a team chat and AI agent app: asking it to summarize a thread, make a task list, explain a feature, write a short poem, plan a meeting agenda with no sensitive content",
 "numeric": "NOT sensitive but FULL of numbers: public dollar amounts and dates (filing deadlines, standard deduction, published contract awards, public budget lines, stock or earnings figures already reported), version numbers, line numbers and stack traces, unit conversions, math or spreadsheet formulas, schedules and times, statistics from public reports, ticket-style IDs for public issues, sample code with numeric constants",
 "long_benign": "NOT sensitive but LONG (90 to 160 words): a detailed public-information question, a long pasted public article excerpt to summarize, a multi-part drafting request with only generic details, a long technical question with fake placeholder data, a long meeting-agenda request with no sensitive specifics",
 "labelled_fake": "NOT sensitive because the values are plainly fake, sample, mock, dummy, demo or training data and the message SAYS so or makes it obvious: 'for the training exercise say the contract is $1,234,567.89', 'demo login is demo/password123 on the vendor's public sandbox', 'Jane Doe, salary $12,345, fictional, for the formula demo', 'the fake award number is ABC-00-X-0000', all-zeros or sequential placeholder values, Acme Widgets LLC and Foo Corp style example entities, scenarios for a class, workshop, tabletop or template",
 "public_ref": "NOT sensitive: PUBLIC reference numbers and facts that look like data: TCP/UDP port lists, HTTP status codes, RFC numbers, court case citations and U.S.C. or CFR sections, published statutory dollar thresholds and fees, FAR/DFARS clause numbers, ZIP and area code facts, public holidays and dates, standard rates and limits published by agencies, well-known protocol and CVE identifiers discussed generally, version numbers and hashes of open-source releases",
 "tech_docs": "NOT sensitive: PUBLIC technical documentation and README-style prose written by an open-source or government-digital-service team about how their own system works, in general terms: architecture overviews, encryption and authentication DESIGN described conceptually (algorithms, protocols, key sizes, why a design was chosen), API behavior, deployment steps with placeholder hosts, release notes, roles and permissions explained, rate limits, troubleshooting guides, changelog entries, privacy policy wording, feature descriptions with UI labels. Written as full paragraphs (40 to 120 words), the way a project README or design doc reads. Technical and security vocabulary is expected and fine; there are no real hosts, no secret values, no unreleased details, no named incidents.",
 "es_benign": "ordinary or public-information messages in Spanish about work, taxes in general, scheduling, or tech help, with nothing sensitive",
}
RULES = """Rules for realism and labelling:
- This is training data for a filter that warns people before they paste sensitive business information into a chat app used by a federal agency team and its contractors. Every name, company, number, key, host and amount you write must be FABRICATED. Never use a real person, real company secret, or real working credential. Invent plausible-looking values (for keys, use random-looking strings that do NOT match a real provider's exact prefix format, e.g. use 'k_live_' style invented prefixes or plain random strings).
- Make examples diverse in topic, voice, length, formatting and opening words. Do not start many with the same phrase. No two examples may be near-duplicates.
- A message is SENSITIVE only if it contains concrete, specific, non-public details (an actual-looking value, figure, name tied to an action, or marked text). Merely mentioning a topic does not make it sensitive.
- Do not include personal identifiers (SSNs, card numbers, phone numbers, home addresses) as the sensitive element: a separate model already handles those. Names are fine as context."""

NODIGIT = " IMPORTANT: every message must be sensitive WITHOUT containing any digits at all (no numbers, no dollar figures, no dates with numerals): the sensitivity must come from words, names, descriptions, marked text, or a secret made only of letters. Write amounts and counts in words if at all."
REALFMT = " IMPORTANT FORMAT RULE for this batch: use the REAL, well-known credential FORMATS that providers document, filled with random invented characters (so they look exactly like real ones but are not): AWS access key IDs starting AKIA or ASIA followed by 16 upper-case letters and digits (sometimes shown alone with no secret), GitHub tokens ghp_ / gho_ / github_pat_, Slack xoxb- / xoxp-, Stripe sk_live_ / rk_live_, Google AIza..., SendGrid SG., npm npm_, PEM private key headers, JWTs, bearer tokens, database URLs with passwords, long hex secrets. About a third of the messages should contain just the bare key with very little context."
def prompt_pos(cat, n, styles, seed, second=None, nodigit=False, realfmt=False):
    cats = [cat] + ([second] if second else [])
    desc = "\n".join(f"- {c}: {CATEGORIES[c]}" for c in cats)
    want = f"each message must contain concrete details of ALL of these kinds at once" if second else "each message must clearly contain this kind of sensitive information"
    return f"""Write {n} different realistic chat messages that an employee might paste or type, {want}:
{desc}

Styles to cover (spread across them): {'; '.join(styles)}.
Setting hints (vary freely): {seed}.

{RULES}

{NODIGIT if nodigit else ""}{REALFMT if realfmt else ""}

Output ONLY a JSON array of {n} objects, no prose, no code fence. Each object: {{"text": "<the message>", "labels": {json.dumps(cats)}}}"""

def prompt_neg(kind, n, styles, seed):
    return f"""Write {n} different realistic chat messages that an employee might type to an AI assistant or coworker. They must be NOT sensitive: {NEG_TYPES[kind]}.

Styles to cover (spread across them): {'; '.join(styles)}.
Setting hints (vary freely): {seed}.

{RULES}
- Every message here is a NEGATIVE example: it must contain no concrete non-public details of any kind.

Output ONLY a JSON array of {n} objects, no prose, no code fence. Each object: {{"text": "<the message>", "labels": []}}"""

SEEDS = ["IT modernization program","a field office","a contractor onboarding","a quarterly review","a cloud migration","a benefits office","an audit follow-up","a help desk","a legal review","a data-center move","customer service operations","a hiring panel","a software vendor renewal","a records office","a training program","an inspector-general request","a mobile app release","a network upgrade","a policy working group","a small-business set-aside"]

def call(job):
    jid, prompt = job["id"], job["prompt"]
    path = f"{OUT}/{jid}.json"
    if os.path.exists(path): return jid, 0.0, "cached"
    for attempt in range(3):
        try:
            r = subprocess.run(["claude","-p",prompt,"--model",MODEL,"--max-turns","1","--output-format","json"], capture_output=True, text=True, timeout=600, cwd="/tmp")
            d = json.loads(r.stdout)
            if d.get("is_error"): raise RuntimeError(d.get("result","")[:200])
            txt = d["result"].strip()
            if txt.startswith("```"): txt = txt.split("\n",1)[1].rsplit("```",1)[0]
            items = json.loads(txt)
            json.dump({"job": job["meta"], "items": items, "cost": d.get("total_cost_usd",0)}, open(path,"w"))
            return jid, d.get("total_cost_usd",0), f"{len(items)} items"
        except Exception as e:
            err = str(e)[:150]; time.sleep(2)
    return jid, 0.0, f"FAILED {err}"

def build(scale):
    rnd = random.Random(int(os.environ.get("GEN_SEED", "7"))); jobs = []
    cats = list(CATEGORIES)
    for c in cats:
        for k in range(scale["pos_calls"]):
            st = rnd.sample(STYLES, 4); seed = ", ".join(rnd.sample(SEEDS, 3))
            jobs.append({"id": f"pos_{c}_{k}", "meta": {"kind":"pos","cats":[c]}, "prompt": prompt_pos(c, scale["n"], st, seed)})
    for c in cats:
        for k in range(scale.get("nodigit_calls", 0)):
            st = rnd.sample(STYLES, 4); seed = ", ".join(rnd.sample(SEEDS, 3))
            jobs.append({"id": f"posnd_{c}_{k}", "meta": {"kind":"pos","cats":[c]}, "prompt": prompt_pos(c, scale["n"], st, seed, nodigit=True)})
    for k in range(scale["multi_calls"]):
        a, b = rnd.sample(cats, 2); st = rnd.sample(STYLES, 4); seed = ", ".join(rnd.sample(SEEDS, 3))
        jobs.append({"id": f"multi_{a}_{b}_{k}", "meta": {"kind":"multi","cats":[a,b]}, "prompt": prompt_pos(a, scale["n"], st, seed, second=b)})
    for kind in NEG_TYPES:
        for k in range(scale["neg_calls"] if kind not in ("numeric", "long_benign") else scale["neg_calls"] + scale.get("extra_neg", 0)):
            st = rnd.sample(STYLES, 4); seed = ", ".join(rnd.sample(SEEDS, 3))
            jobs.append({"id": f"neg_{kind}_{k}", "meta": {"kind":"neg","type":kind}, "prompt": prompt_neg(kind, scale["n"], st, seed)})
    return jobs

if __name__ == "__main__":
    scale = json.loads(sys.argv[1]); par = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    jobs = build(scale); print("jobs:", len(jobs), flush=True)
    total = 0.0; done = 0
    with cf.ThreadPoolExecutor(par) as ex:
        for jid, cost, msg in ex.map(call, jobs):
            total += cost; done += 1
            print(f"[{done}/{len(jobs)}] {jid}: {msg} (${cost:.3f}, total ${total:.2f})", flush=True)
    print("DONE total cost $%.2f" % total, flush=True)
