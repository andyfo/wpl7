/**
 * The shell half of Web FTP. Every file operation is one of these scripts, run by
 * SiteFilesService INSIDE the site's own container as www-data (see siteFiles.ts for why
 * nothing here ever runs on the host).
 *
 * Conventions, all of them load-bearing:
 * - Everything the caller supplies arrives as a positional argument (`sh -c SCRIPT sh a b`).
 *   Nothing is spliced into the script text, so no path can inject shell, and every path is
 *   absolute (`/var/www/html/...`), so none can be read as an option either.
 * - Exit codes from FILE_EXIT mean one specific thing each, and siteFiles.ts turns them into
 *   the matching HTTP error. Anything else is a failure nobody predicted, reported with stderr.
 * - The site image is Debian (`wordpress:*-apache`), so the GNU tools are a given: `find
 *   -printf`, `head -z`, `stat -c`, `chmod --reference`, `mv -T`, `timeout`.
 * - The `timeout` the panel wraps every exec in sends TERM. Without the trap, `sh` would die
 *   on it without running its EXIT trap, and a half-written temporary file would stay behind.
 */

export const FILE_EXIT = {
  notFound: 10,
  /** A folder where a file was expected, a link where chmod cannot go, and so on. */
  wrongType: 11,
  denied: 12,
  exists: 13,
  /** The file is not the one the request was based on (If-Match), or is gone. */
  changed: 14,
  tooLarge: 15,
  /** The bytes that landed are not the bytes that were sent. Nothing was replaced. */
  short: 16,
  /** An upload chunk for the wrong offset; stdout holds the size received so far. */
  offset: 17,
  noSpace: 18,
  intoItself: 19,
  badPattern: 20,
  syntax: 21,
  badArchive: 22,
  unsafeArchive: 23,
  /** Another of the panel's writes into the same folder held its lock for too long. */
  busy: 24,
} as const;

const E = FILE_EXIT;

/**
 * One entry as a record: `flags/y/Y/size/mode/mtime/uid/gid/name/target` + NUL.
 *
 * `flags` is `r`/`-` then `w`/`-`, from access(2) as www-data - what the site may do, which
 * is what the Files tab may do. Names cannot contain `/`, so it is a safe separator; the
 * link target, which can, comes last and takes the rest of the record.
 */
const RECORD = `\\( -readable -printf r -o -printf - \\) \\( -writable -printf w -o -printf - \\) -printf '/%y/%Y/%s/%m/%T@/%U/%G/%f/%l\\0'`;
const LIST_RECORD = RECORD.replace('%f', '%P');

/**
 * `lock DIR` serialises the panel's own writes into one folder until the script exits: two
 * saves based on the same version must not both pass their check and both rename, the second
 * silently replacing the first. A script checks its precondition again once it holds the lock,
 * just before the rename. Best effort where the filesystem cannot lock at all (flock failing
 * other than by timing out, which is exit 1): the write goes ahead unlocked, as it did before.
 */
const PRELUDE = `set -u
trap 'exit 143' TERM HUP INT
entry() { find "$1" -maxdepth 0 ${RECORD}; }
lock() {
  [ -r "$1" ] || return 0
  exec 9< "$1"
  flock -w 30 9
  [ $? != 1 ] || exit ${E.busy}
}
`;

const script = (body: string): string => PRELUDE + body.trim() + '\n';

export const SCRIPTS = {
  /**
   * args: dir, maxRecords. The folder's own record comes first (`%P` is empty for it); the
   * listing is cut at maxRecords, one NUL-terminated record per entry. `cd` first, so a
   * folder reached through a symlink is entered - inside the container's own filesystem.
   */
  list: script(`
[ -e "$1" ] || exit ${E.notFound}
[ -d "$1" ] || exit ${E.wrongType}
{ [ -r "$1" ] && [ -x "$1" ]; } || exit ${E.denied}
cd "$1" || exit ${E.denied}
find . -maxdepth 1 ${LIST_RECORD} | head -z -n "$2"
`),

  /** args: path. One record. */
  stat: script(`
[ -e "$1" ] || [ -L "$1" ] || exit ${E.notFound}
entry "$1"
`),

  /** args: file, maxBytes. The content, never more than maxBytes + 1 (which reads as "too large"). */
  read: script(`
[ -e "$1" ] || exit ${E.notFound}
[ -f "$1" ] || exit ${E.wrongType}
[ -r "$1" ] || exit ${E.denied}
size=$(stat -L -c %s -- "$1") || exit ${E.denied}
[ "$size" -le "$2" ] || exit ${E.tooLarge}
exec head -c "$(( $2 + 1 ))" -- "$1"
`),

  /** args: path. What a download is: `d`, or `f <size>`. */
  probe: script(`
[ -e "$1" ] || exit ${E.notFound}
[ -r "$1" ] || exit ${E.denied}
if [ -d "$1" ]; then
  [ -x "$1" ] || exit ${E.denied}
  printf d
  exit 0
fi
[ -f "$1" ] || exit ${E.wrongType}
printf 'f %s' "$(stat -L -c %s -- "$1")"
`),

  /** args: file, bytes. Exactly that many bytes (fewer if the file shrank meanwhile). */
  cat: script(`
exec head -c "$2" -- "$1"
`),

  /**
   * args: parent, name, rename-top-to. A folder as .tar.gz on stdout. Files that vanish or
   * change while being read are tolerated (tar's exit 1): a live site is being archived.
   * The panel's own temporary files are left out.
   */
  tar: script(`
cd "$1" || exit ${E.denied}
if [ -n "$3" ]; then
  tar --ignore-failed-read --exclude='.wpl7-*' --transform "s,^$2,$3," -czf - -- "$2"
else
  tar --ignore-failed-read --exclude='.wpl7-*' -czf - -- "$2"
fi
s=$?
[ "$s" -le 1 ] || exit "$s"
`),

  /**
   * args: target, mode (create|replace|any), expected-sha256 (or -), length, sha256, lint (php|-).
   * stdin: the new content. `replace` needs the target to exist, and with an expected
   * SHA-256 to be exactly that version; `-` accepts any version (If-Match: *).
   *
   * The content goes to a temporary file beside the target, is checked (every byte arrived;
   * optionally, it parses as PHP), and only then takes the target's place in one rename -
   * a request that dies half-way can never leave a truncated wp-config.php behind, and a
   * visitor never runs a half-written one. A link is written through, as an editor would.
   * `create` uses a hard link instead of the rename, which fails if the name was taken
   * meanwhile rather than replacing what just appeared. The precondition is checked before
   * the content is read, so a stale save fails fast, and again under the folder's lock right
   * before the rename, so a save that finished meanwhile is not silently replaced.
   */
  write: script(`
t=$1 mode=$2 want=$3 len=$4 sha=$5 lint=$6
if [ -L "$t" ]; then
  t=$(readlink -f -- "$t") || exit ${E.notFound}
fi
d=$(dirname -- "$t")
[ -d "$d" ] || exit ${E.notFound}
precondition() {
  if [ -e "$t" ]; then
    [ -f "$t" ] || exit ${E.wrongType}
    [ "$mode" != create ] || exit ${E.exists}
    if [ "$want" != - ]; then
      [ -r "$t" ] || exit ${E.denied}
      set -- $(sha256sum < "$t")
      [ "$1" = "$want" ] || exit ${E.changed}
    fi
  elif [ "$mode" = replace ]; then
    exit ${E.changed}
  fi
}
precondition
[ -w "$d" ] || exit ${E.denied}
tmp=$(mktemp -- "$d/.wpl7-edit.XXXXXXXXXX") || exit ${E.denied}
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp" || exit ${E.short}
[ "$(stat -c %s -- "$tmp")" = "$len" ] || exit ${E.short}
set -- $(sha256sum < "$tmp")
[ "$1" = "$sha" ] || exit ${E.short}
if [ "$lint" = php ] && command -v php > /dev/null; then
  if ! out=$(php -n -l < "$tmp" 2>&1); then
    printf '%s\\n' "$out" >&2
    exit ${E.syntax}
  fi
fi
lock "$d"
precondition
if [ -e "$t" ]; then
  chmod --reference="$t" -- "$tmp" 2>/dev/null || chmod 644 -- "$tmp"
else
  chmod 644 -- "$tmp"
fi
if [ "$mode" = create ]; then
  if ! ln -- "$tmp" "$t" 2>/dev/null; then
    [ -e "$t" ] && exit ${E.exists}
    exit ${E.denied}
  fi
else
  mv -f -T -- "$tmp" "$t" || exit ${E.denied}
fi
entry "$t"
`),

  /**
   * args: part, offset, length, sha256, total, target, overwrite (1|0), min-free-bytes.
   * stdin: this chunk.
   *
   * Uploads arrive in chunks (Traefik cuts off any request that takes over 60 s), appended
   * to `<dir>/.wpl7-upload-<id>.part`. Offset 0 checks the target and the free space and
   * starts the part afresh; any other offset must equal the part's size, or the script
   * answers with the size it has so the client can resume from there. A chunk that did not
   * land whole is cut back off. The chunk that makes the part complete puts it in place.
   * An empty chunk at offset == total only commits (a retry after "already exists").
   */
  append: script(`
p=$1 off=$2 len=$3 sha=$4 total=$5 t=$6 ow=$7 minfree=$8
d=$(dirname -- "$p")
if [ "$off" = 0 ]; then
  [ -d "$d" ] || exit ${E.notFound}
  [ -w "$d" ] || exit ${E.denied}
  if [ -e "$t" ] || [ -L "$t" ]; then
    [ "$ow" = 1 ] || exit ${E.exists}
    [ -f "$t" ] || exit ${E.wrongType}
  fi
  set -- $(df -Pk -- "$d" | tail -n 1)
  [ $(( $4 * 1024 - total )) -ge "$minfree" ] || exit ${E.noSpace}
  find "$d" -maxdepth 1 -name '.wpl7-upload-*.part' -mmin +1440 -delete 2>/dev/null
  : > "$p" || exit ${E.denied}
else
  [ -f "$p" ] || exit ${E.notFound}
  cur=$(stat -c %s -- "$p")
  if [ "$cur" != "$off" ]; then
    printf '%s' "$cur"
    exit ${E.offset}
  fi
fi
if [ "$len" != 0 ]; then
  if ! cat >> "$p"; then
    truncate -s "$off" -- "$p"
    exit ${E.short}
  fi
  if [ "$(stat -c %s -- "$p")" != $(( off + len )) ]; then
    truncate -s "$off" -- "$p"
    exit ${E.short}
  fi
  set -- $(tail -c "$len" -- "$p" | sha256sum)
  if [ "$1" != "$sha" ]; then
    truncate -s "$off" -- "$p"
    exit ${E.short}
  fi
fi
[ "$(stat -c %s -- "$p")" = "$total" ] || exit 0
if [ -L "$t" ]; then
  t=$(readlink -f -- "$t") || exit ${E.notFound}
fi
lock "$(dirname -- "$t")"
if [ -e "$t" ]; then
  [ "$ow" = 1 ] || exit ${E.exists}
  [ -f "$t" ] || exit ${E.wrongType}
  chmod --reference="$t" -- "$p" 2>/dev/null || chmod 644 -- "$p"
  mv -f -T -- "$p" "$t" || exit ${E.denied}
else
  chmod 644 -- "$p"
  if ! ln -- "$p" "$t" 2>/dev/null; then
    [ -e "$t" ] && exit ${E.exists}
    exit ${E.denied}
  fi
  rm -f -- "$p"
fi
entry "$t"
`),

  /** args: part. */
  abort: script(`
rm -f -- "$1"
`),

  /** args: path. */
  mkdir: script(`
if [ -e "$1" ] || [ -L "$1" ]; then exit ${E.exists}; fi
d=$(dirname -- "$1")
[ -d "$d" ] || exit ${E.notFound}
[ -w "$d" ] || exit ${E.denied}
mkdir -- "$1" || exit ${E.denied}
entry "$1"
`),

  /**
   * args: from, to, overwrite (1|0). Renames and moves; both folders must be writable. A
   * folder is never replaced, and never moved into itself. Under the target folder's lock,
   * like a save: a move over a file is a write to it.
   */
  move: script(`
s=$1 t=$2 ow=$3
[ -e "$s" ] || [ -L "$s" ] || exit ${E.notFound}
case "$t/" in "$s/"*) exit ${E.intoItself} ;; esac
sd=$(dirname -- "$s")
td=$(dirname -- "$t")
[ -d "$td" ] || exit ${E.notFound}
{ [ -w "$sd" ] && [ -w "$td" ]; } || exit ${E.denied}
lock "$td"
if [ -e "$t" ] || [ -L "$t" ]; then
  [ "$ow" = 1 ] || exit ${E.exists}
  if [ -d "$t" ] && [ ! -L "$t" ]; then exit ${E.wrongType}; fi
fi
mv -f -T -- "$s" "$t" || exit ${E.denied}
entry "$t"
`),

  /**
   * args: from, to, min-free-bytes. Links are copied as links (-P), never followed. Refused
   * when the copy would leave less than min-free-bytes on the disk.
   */
  copy: script(`
s=$1 t=$2 minfree=$3
[ -e "$s" ] || [ -L "$s" ] || exit ${E.notFound}
[ -r "$s" ] || [ -L "$s" ] || exit ${E.denied}
case "$t/" in "$s/"*) exit ${E.intoItself} ;; esac
if [ -e "$t" ] || [ -L "$t" ]; then exit ${E.exists}; fi
td=$(dirname -- "$t")
[ -d "$td" ] || exit ${E.notFound}
[ -w "$td" ] || exit ${E.denied}
need=$(du -sk -- "$s" | cut -f1)
set -- $(df -Pk -- "$td" | tail -n 1)
[ $(( ($4 - need) * 1024 )) -ge "$minfree" ] || exit ${E.noSpace}
cp -R -P --preserve=mode,timestamps -T -- "$s" "$t" || exit ${E.denied}
entry "$t"
`),

  /**
   * args: paths... Everything is checked before anything is deleted, so a batch with one
   * bad name deletes nothing. Deleting needs the PARENT folder writable. `rm` never follows
   * a link: deleting one removes the link, not what it points at.
   */
  remove: script(`
for p in "$@"; do
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then printf '%s' "$p" >&2; exit ${E.notFound}; fi
  if [ ! -w "$(dirname -- "$p")" ]; then printf '%s' "$p" >&2; exit ${E.denied}; fi
done
for p in "$@"; do
  rm -rf -- "$p" || exit ${E.denied}
done
`),

  /** args: path, mode. chmod on a link would change its target, so links are refused. */
  chmod: script(`
[ -e "$1" ] || [ -L "$1" ] || exit ${E.notFound}
[ ! -L "$1" ] || exit ${E.wrongType}
chmod -- "$2" "$1" || exit ${E.denied}
entry "$1"
`),

  /**
   * args: wp-content, wp-content/mu-plugins, name, put|remove, legacy name (or ''), then
   * dropInWrite (the script below). stdin: the content (put).
   *
   * The panel's own drop-ins in wp-content/mu-plugins (the one-click login, the license
   * constants). Starts as ROOT inside the container, because the folder may still be root's
   * from before the panel wrote it this way - and root, even in the container, must not be
   * steerable by the site: www-data owns the whole tree and can swap any folder on the way
   * for a symlink. So root reaches the folder physically (`cd -P`, then `pwd -P` must be
   * exactly the expected path: no link anywhere on the way counts), changes ownership only
   * of `.` - the folder it is standing in, no name left to swap - and with `-h` for the two
   * files, and then drops to www-data for everything that writes (setpriv). The write itself
   * is dropInWrite, as the site's own user.
   */
  dropIn: script(`
parent=$1 d=$2 name=$3 mode=$4 legacy=$5 inner=$6
cd -P -- "$parent" 2>/dev/null || exit ${E.notFound}
[ "$(pwd -P)" = "$parent" ] || exit ${E.wrongType}
base=$(basename -- "$d")
[ ! -L "$base" ] || exit ${E.wrongType}
if [ ! -e "$base" ]; then
  [ "$mode" != remove ] || exit 0
  mkdir -- "$base" 2>/dev/null
fi
cd -P -- "$base" 2>/dev/null || exit ${E.denied}
[ "$(pwd -P)" = "$d" ] || exit ${E.wrongType}
if [ "$(id -u)" = 0 ]; then
  chown 33:33 . || exit ${E.denied}
  for n in "$name" "$legacy"; do
    if [ -n "$n" ] && { [ -e "$n" ] || [ -L "$n" ]; }; then chown -h 33:33 -- "$n"; fi
  done
  exec setpriv --reuid=33 --regid=33 --clear-groups -- sh -c "$inner" sh "$name" "$mode" "$legacy"
fi
exec sh -c "$inner" sh "$name" "$mode" "$legacy"
`),

  /**
   * dropIn's second half, run as www-data in the mu-plugins folder dropIn stands in. args:
   * name, put|remove, legacy name (or ''). Prints what it did: `written`, `same`, `removed`
   * or nothing. Atomic like every write here; a link where the drop-in goes is replaced by
   * the rename, never written through.
   */
  dropInWrite: `set -u
trap 'exit 143' TERM HUP INT
name=$1 mode=$2 legacy=$3
# Best effort: an old drop-in that will not go must not stop the new one working.
if [ -n "$legacy" ] && { [ -e "$legacy" ] || [ -L "$legacy" ]; }; then rm -f -- "$legacy" 2>/dev/null; fi
if [ "$mode" = remove ]; then
  if [ -e "$name" ] || [ -L "$name" ]; then rm -f -- "$name" && printf removed; fi
  exit 0
fi
tmp=$(mktemp -- ".wpl7-edit.XXXXXXXXXX") || exit ${E.denied}
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp" || exit ${E.short}
if [ -f "$name" ] && [ ! -L "$name" ] && cmp -s -- "$tmp" "$name"; then
  printf same
  exit 0
fi
chmod 644 -- "$tmp"
mv -f -T -- "$tmp" "$name" || exit ${E.denied}
printf written
`,

  /**
   * args: path. Run as ROOT inside the container, like dropIn, and as careful: the parent is
   * entered physically and must be exactly where it should be, so a folder on the way that
   * the site swapped for a symlink (wp-content -> /) cannot aim root at the container's
   * own files. From there `-h` changes links themselves and -R (which implies -P) never
   * descends through one, so nothing past the path it was given is touched.
   */
  fixOwnership: script(`
parent=$(dirname -- "$1")
base=$(basename -- "$1")
cd -P -- "$parent" 2>/dev/null || exit ${E.notFound}
[ "$(pwd -P)" = "$parent" ] || exit ${E.wrongType}
[ -e "$base" ] || [ -L "$base" ] || exit ${E.notFound}
chown -R -h 33:33 -- "$base" || exit ${E.denied}
`),

  /**
   * args: dir, pattern, maxRecords, case-sensitive (1|0). Records `type/relative-path` + NUL;
   * a `T/timeout` record says the search ran out of time. Links are not descended into.
   */
  searchNames: script(`
cd "$1" 2>/dev/null || exit ${E.denied}
if [ "$4" = 1 ]; then op=-name; else op=-iname; fi
{
  timeout -k 2 45 find . -mindepth 1 ! -name '.wpl7-*' "$op" "$2" -printf '%y/%P\\0' 2>/dev/null
  [ $? != 124 ] || printf 'T/timeout\\0'
} | head -z -n "$3"
`),

  /**
   * args: dir, pattern, maxLines, fixed (1|0), case-sensitive (1|0), --include=GLOB...
   * Records `./path` NUL `line:text` LF - the path first, because a name may hold a line
   * break but never a NUL. A NUL `TIMEOUT` record says the search ran out of time. Binary
   * files are skipped (-I); at most 20 matches per file. Long lines are cut down to the part
   * around the match by the panel, not here: a cut here could land inside the path.
   */
  searchContent: script(`
d=$1 q=$2 max=$3 fixed=$4 cs=$5
shift 5
cd "$d" 2>/dev/null || exit ${E.denied}
if [ "$fixed" = 1 ]; then kind=-F; else kind=-E; fi
if [ "$cs" = 1 ]; then icase=-e; else icase=-ie; fi
printf '' | grep -q "$kind" "$icase" "$q" 2>/dev/null
if [ $? = 2 ]; then
  printf '' | grep -q "$kind" "$icase" "$q" 2>&1 | head -c 300 >&2
  exit ${E.badPattern}
fi
{
  timeout -k 2 45 grep -rnI --null -m 20 --exclude='.wpl7-*' "$kind" "$@" "$icase" "$q" -- . 2>/dev/null
  [ $? != 124 ] || printf '\\0TIMEOUT\\n'
} | head -n "$max"
`),
} as const;
