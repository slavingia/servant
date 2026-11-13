#!/usr/bin/env bash
# Fails if any tracked file, or any tracked file name, matches a pattern in
# scripts/scrub-denylist.txt (case-insensitive extended regexes, one per line).
# Run before every push; CI runs it on every push and pull request.
#
#   bash scripts/scrub-check.sh
#
# Works with BSD grep (macOS), GNU grep and Python 3. Binary files are skipped.
# Reviewed public identity lines have exact, path-bound exceptions; entire files
# are never excluded. See scripts/scrub-public-lines.py.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

denylist="scripts/scrub-denylist.txt"
if [ ! -f "$denylist" ]; then
  echo "scrub-check: $denylist is missing" >&2
  exit 2
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
patterns="$workdir/patterns"
files="$workdir/files"
hits="$workdir/hits"

# Drop comments and blank lines. An empty pattern would match every line.
grep -vE '^[[:space:]]*(#|$)' "$denylist" > "$patterns" || true
if [ ! -s "$patterns" ]; then
  echo "scrub-check: $denylist has no patterns" >&2
  exit 2
fi

# Tracked files that still exist in the working tree, minus the denylist itself.
: > "$files"
count=0
while IFS= read -r -d '' f; do
  [ "$f" = "$denylist" ] && continue
  [ -f "$f" ] || continue
  printf '%s\0' "$f" >> "$files"
  count=$((count + 1))
done < <(git ls-files -z)

: > "$hits"

# File names. Reported as path:0:<file name>.
tr '\0' '\n' < "$files" | grep -iE -f "$patterns" | sed 's/$/:0:<file name>/' >> "$hits" || true

# Contents. -I skips binary files; long lines (minified code) are cut to 240 characters.
if [ "$count" -gt 0 ]; then
  xargs -0 grep -IinHE -f "$patterns" -- < "$files" | cut -c1-240 >> "$hits" || true
fi

# Match complete source lines before allowing an exception, even though grep's
# displayed excerpt is truncated. Unknown paths, edited lines and filenames fail.
python3 scripts/scrub-public-lines.py "$hits" > "$workdir/reviewed-hits"
mv "$workdir/reviewed-hits" "$hits"

if [ -s "$hits" ]; then
  cat "$hits"
  n=$(wc -l < "$hits" | tr -d ' ')
  nfiles=$(cut -d: -f1 "$hits" | sort -u | wc -l | tr -d ' ')
  echo "scrub-check: $n hit(s) in $nfiles file(s). Remove them, or fix $denylist if a pattern is wrong." >&2
  exit 1
fi

echo "scrub-check: OK, $count tracked files clean against $(wc -l < "$patterns" | tr -d ' ') patterns."
