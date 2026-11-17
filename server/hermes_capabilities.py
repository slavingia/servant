"""Which built-in entitlement a tool call needs (docs/entitlements.md, "Built-in entitlements").

Four of them: reading files, changing files, reading GitHub, changing GitHub. The agent's own file tools are exact.
A shell command is read as carefully as a shell command can be, and the rule is one-sided on purpose: a command
counts as reading only when every part of it is on a short list of commands known to only read. Anything else
needs "filesystem write", and anything that talks to GitHub and isn't a known read needs "GitHub write". A wrong
guess therefore asks for more than was needed, never less.

No Hermes imports here, so it can be tested with any Python.
"""
import re
import shlex

FS_READ, FS_WRITE, GH_READ, GH_WRITE = "fs-read", "fs-write", "github-read", "github-write"
# Asked for in this order, the weightiest first, so a person isn't asked twice for one command when one answer says no.
ORDER = (GH_WRITE, FS_WRITE, GH_READ, FS_READ)

# Hermes tools that read or change files without a shell.
TOOL_NEEDS = {
    "read_file": {FS_READ}, "search_files": {FS_READ},
    "write_file": {FS_WRITE}, "patch": {FS_WRITE},
    # These run whatever they are given: treated as able to change files.
    "execute_code": {FS_WRITE}, "computer_use": {FS_WRITE}, "skill_manage": {FS_WRITE}, "cronjob": {FS_WRITE},
}
SHELL_TOOLS = {"terminal"}

# Commands that only read, whatever their arguments (output redirection is checked separately).
READ_ONLY = frozenset("""
ls cat head tail less more grep egrep fgrep rg wc pwd echo printf which whereis type stat file diff cmp tree du df date
env printenv true false test [ sort uniq cut tr jq yq basename dirname realpath readlink id whoami hostname uname
uptime ps column nl tac rev fold strings md5 md5sum shasum sha1sum sha256sum cksum hexdump xxd od comm join paste
seq sleep cd pushd popd export unset set shopt alias history command builtin exit return
""".split())
# find and sed read unless told otherwise.
FIND_WRITES = {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"}

GIT_READ = frozenset("status log diff show blame describe rev-parse rev-list ls-files ls-tree cat-file shortlog reflog grep whatchanged name-rev merge-base for-each-ref show-ref count-objects var version help".split())
# Read GitHub and change files on disk.
GIT_FETCH = frozenset("fetch pull clone ls-remote".split())
GIT_SEND = frozenset("push".split())
# Reads with these arguments, writes otherwise.
GIT_READ_FORMS = {"branch": {"", "-a", "-r", "-v", "-vv", "--list", "--show-current", "-l"}, "remote": {"", "-v", "show", "get-url"}, "tag": {"", "-l", "--list", "-n"},
                  "stash": {"list", "show"}, "config": {"--get", "--list", "-l", "--get-all", "--get-regexp"}, "worktree": {"list"}, "submodule": {"", "status"}}

GH_READ_FORMS = {
    "pr": {"view", "list", "diff", "checks", "status"}, "issue": {"view", "list", "status"}, "repo": {"view", "list"},
    "run": {"view", "list", "watch"}, "workflow": {"view", "list"}, "release": {"view", "list"}, "search": None, "status": None,
    "auth": {"status"}, "label": {"list"}, "gist": {"view", "list"}, "project": {"view", "list", "item-list", "field-list"},
    "cache": {"list"}, "ruleset": {"view", "list", "check"}, "browse": None, "help": None, "version": None, "variable": {"list", "get"}, "secret": {"list"},
}
GH_FETCH = {("pr", "checkout"), ("repo", "clone"), ("release", "download"), ("run", "download"), ("gist", "clone")}

SEPARATORS = {";", "&&", "||", "|", "&", "\n", "|&"}
# Constructs this reader does not follow into: treated as able to do anything.
OPAQUE = re.compile(r"\$\(|`|<\(|>\(")
WRAPPERS = {"sudo", "nohup", "time", "nice", "command", "builtin", "stdbuf", "caffeinate"}
# Commands that run another command they are given.
RUNNERS = {".", "source", "eval", "exec", "xargs", "sh", "bash", "zsh", "dash", "fish", "ksh", "python", "python3", "node", "ruby", "perl", "php", "osascript", "make", "npm", "npx", "yarn", "pnpm", "pip", "pip3", "uv", "brew", "docker", "ssh", "scp", "rsync", "curl", "wget", "awk", "tee", "dd", "open"}
GITHUB_HOST = re.compile(r"(^|[/@.])(github\.com|githubusercontent\.com|ghcr\.io)([/:]|$)", re.I)


def _segments(command):
    """The command split at ; && || | & and newlines, each as a list of words. None when it can't be read."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        words = []
        for token in lexer:
            words.extend(part if part else "\n" for part in token.split("\n")) if "\n" in token and token.strip("\n") == "" else words.append(token)
    except ValueError:
        return None
    segments, current = [], []
    for word in words:
        if word in SEPARATORS or (word and set(word) <= set(";&|")):
            if current:
                segments.append(current)
            current = []
        else:
            current.append(word)
    if current:
        segments.append(current)
    return segments


def _redirects_output(words):
    for word in words:
        if word.startswith(("2>&1", ">&2", "1>&2", "2>/dev/null", ">/dev/null", "1>/dev/null", "&>/dev/null")):
            continue
        if re.match(r"^\d*>>?", word) or re.match(r"^&>", word):
            return True
    return False


def _strip_redirect_targets(words):
    """Drop harmless redirections and their targets so they are not mistaken for arguments."""
    out, skip = [], False
    for word in words:
        if skip:
            skip = False
            continue
        if word in ("2>", ">", "1>", "&>") :
            skip = True
            continue
        if re.match(r"^\d*[<>]", word) or word.startswith("&>"):
            continue
        out.append(word)
    return out


def _git_needs(args):
    # Skip options that come before the subcommand (-C dir, -c name=value, --no-pager ...).
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in ("-C", "-c", "--git-dir", "--work-tree") else 1
    if i >= len(args):
        return {FS_READ}
    sub, rest = args[i], args[i + 1:]
    if sub in GIT_READ:
        return {FS_READ}
    if sub in GIT_FETCH:
        return {GH_READ} if sub == "ls-remote" else {GH_READ, FS_WRITE}
    if sub in GIT_SEND:
        return {GH_WRITE}
    forms = GIT_READ_FORMS.get(sub)
    if forms is not None:
        first = rest[0] if rest else ""
        if first in forms or (sub == "branch" and all(a.startswith("-") and a in forms for a in rest)):
            return {FS_READ}
    return {FS_WRITE}


def _gh_needs(args):
    words = [a for a in args if not a.startswith("-")]
    if not words:
        return {GH_READ}
    group = words[0]
    if group == "api":
        return {GH_READ} if _gh_api_is_get(args) else {GH_WRITE}
    if group not in GH_READ_FORMS:
        return {GH_WRITE}
    forms = GH_READ_FORMS[group]
    if forms is None:
        return {GH_READ}
    action = words[1] if len(words) > 1 else ""
    # Fetching something through gh reads GitHub and changes files here.
    if (group, action) in GH_FETCH:
        return {GH_READ, FS_WRITE}
    return {GH_READ} if action in forms else {GH_WRITE}


def _gh_api_is_get(args):
    """`gh api` reads unless it is given a method other than GET or a field to send."""
    method = None
    for i, a in enumerate(args):
        if a in ("-X", "--method") and i + 1 < len(args):
            method = args[i + 1]
        elif a.startswith("--method="):
            method = a.split("=", 1)[1]
        elif re.match(r"^-X[A-Za-z]+$", a):
            method = a[2:]
    sends = any(re.match(r"^(-f|-F|--field|--raw-field|--input)($|=)", a) for a in args)
    return (method or "GET").upper() == "GET" and not sends


def _segment_needs(words):
    needs = set()
    if _redirects_output(words):
        needs.add(FS_WRITE)
    words = _strip_redirect_targets(words)
    # Leading NAME=value assignments and wrappers such as sudo don't change what runs.
    while words and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]) or words[0] in WRAPPERS):
        words = words[1:]
    if not words:
        return needs
    name, args = words[0].rsplit("/", 1)[-1], words[1:]
    # A GitHub address, or git or gh inside something this command will run.
    mentions_github = any(GITHUB_HOST.search(a) or re.search(r"(^|[\s;&|(`'\"])(gh|git)(\s|$)", a) for a in args)
    if name == "git":
        needs |= _git_needs(args)
    elif name == "gh":
        needs |= _gh_needs(args)
    elif name == "find":
        needs.add(FS_WRITE if any(a in FIND_WRITES for a in args) else FS_READ)
    elif name == "sed":
        needs.add(FS_WRITE if any(a == "-i" or a.startswith("-i") or a == "--in-place" or "w" in a and a.startswith("-") for a in args) else FS_READ)
    elif name in READ_ONLY:
        needs.add(FS_READ)
    else:
        # Not known to only read (or known to run other things): able to change files, and GitHub if it names it.
        needs.add(FS_WRITE)
        if mentions_github:
            needs.add(GH_WRITE)
    return needs


def _least(needs):
    """Write covers read, so a command that needs both is asked about once."""
    if FS_WRITE in needs:
        needs.discard(FS_READ)
    if GH_WRITE in needs:
        needs.discard(GH_READ)
    return needs or {FS_READ}


def command_needs(command):
    """The built-in entitlements a shell command needs, as a set. Never empty: running anything reads something."""
    return _least(_command_needs(command))


def _command_needs(command):
    if not isinstance(command, str) or not command.strip():
        return {FS_READ}
    needs = set()
    if OPAQUE.search(command):
        needs.add(FS_WRITE)
        if GITHUB_HOST.search(command) or re.search(r"(^|[\s;&|(`])(gh|git)\s", command):
            needs.add(GH_WRITE)
    segments = _segments(command)
    if segments is None:
        needs.add(FS_WRITE)
        if GITHUB_HOST.search(command) or re.search(r"(^|[\s;&|(`])(gh|git)\s", command):
            needs.add(GH_WRITE)
        return needs
    for words in segments:
        needs |= _segment_needs(words)
    return needs or {FS_READ}


def tool_needs(tool_name, args):
    """What a tool call needs: a set of built-in entitlements, empty when the tool touches neither files nor GitHub."""
    args = args if isinstance(args, dict) else {}
    if tool_name in SHELL_TOOLS:
        return command_needs(args.get("command"))
    return set(TOOL_NEEDS.get(tool_name, ()))


def in_order(needs):
    return [n for n in ORDER if n in needs]


def describe(tool_name, args, limit=300):
    """One line for the person deciding: what the agent was about to do. Kept short; never sent in a push alert."""
    args = args if isinstance(args, dict) else {}
    if tool_name in SHELL_TOOLS:
        text = "Run: " + " ".join(str(args.get("command") or "").split())
    elif tool_name in ("read_file", "write_file", "patch"):
        verb = {"read_file": "Read", "write_file": "Write", "patch": "Change"}[tool_name]
        text = "%s %s" % (verb, args.get("path") or args.get("file_path") or "a file")
    elif tool_name == "search_files":
        text = "Search files for %s" % (args.get("pattern") or args.get("query") or "a pattern")
        if args.get("path"):
            text += " in %s" % args["path"]
    else:
        text = "Use %s" % tool_name
    return text if len(text) <= limit else text[: limit - 1] + "…"
