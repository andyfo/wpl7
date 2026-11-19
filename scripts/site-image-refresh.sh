#!/usr/bin/env bash
# The steps of .github/workflows/site-images-refresh.yml, which keeps the published site images on
# the newest PHP without a WPL7 release.
#
#   plan                      which images to rebuild: JSON for the build matrix
#   php <image>               the PHP release in an image's linux/amd64 build
#   check <built> <published> <published PHP>
#                             whether the build is worth pushing: a newer PHP, or a package
#                             or a PHP extension that changed
#   push <built> <published> <published digest> [<also>]
#                             push, unless the published image changed since the plan
#
# Needs docker with buildx, jq and gh. Reads REPOSITORY (owner/name), MODE (php, weekly or
# dry-run) and GH_TOKEN from the environment.
set -euo pipefail

ARCH=amd64
# What changing a site image can change: every package and every PHP extension, with versions. The
# panel's own builds compare the same list (panel/src/services/phpUpdates.ts).
FINGERPRINT="dpkg-query -W -f '\${Package}=\${Version}\n' | LC_ALL=C sort; php -r 'foreach (get_loaded_extensions() as \$e) { echo \$e, \"=\", phpversion(\$e), \"\n\"; }' | LC_ALL=C sort"

die() {
  echo "::error::$*" >&2
  exit 1
}

# True when version $1 is newer than $2, as sort -V ranks them.
newer() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

# What the registry says of an image's linux/amd64 build, without a pull: its manifest's digest
# (of the list, when it is one; `-` unless asked with `digest`) and its PHP release, on one line.
# The list, then that one image: two manifest requests, which is what Docker Hub counts, and a
# third for the digest. Nothing when it cannot tell, whatever the reason: the callers skip it
# rather than guess.
facts_of() {
  local ref=$1 want=${2:-} raw digest=- config php
  raw="$(docker buildx imagetools inspect --raw "$ref" 2>/dev/null)" || return 0
  if [ "$want" = digest ]; then
    digest="$(docker buildx imagetools inspect --format '{{json .Manifest}}' "$ref" 2>/dev/null | jq -r '.digest // empty' 2>/dev/null)" || return 0
    [ -n "$digest" ] || return 0
  fi
  if jq -e '.manifests' >/dev/null 2>&1 <<<"$raw"; then
    local one
    one="$(jq -r --arg arch "$ARCH" '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch)][0].digest // empty' <<<"$raw")" || return 0
    [ -n "$one" ] || return 0
    ref="${ref%:*}@$one"
  fi
  config="$(docker buildx imagetools inspect --format '{{json .Image}}' "$ref" 2>/dev/null)" || return 0
  php="$(jq -r '.config.Env // [] | map(select(startswith("PHP_VERSION="))) | first // "" | sub("^PHP_VERSION="; "")' <<<"$config" 2>/dev/null)" || return 0
  [ -n "$php" ] || return 0
  echo "$digest $php"
}

php_of() {
  local facts
  facts="$(facts_of "$1")"
  [ -n "$facts" ] && cut -d' ' -f2 <<<"$facts"
  return 0
}

fingerprint() {
  docker run --rm --network none --entrypoint sh "$1" -c "$FINGERPRINT"
}

# The release's manifest, as update.sh reads it: its commit and its site images.
manifest_of() {
  gh release download "$1" --repo "$REPOSITORY" --pattern manifest.json --output - 2>/dev/null
}

plan() {
  local stable entries='[]' manifest sha php ref also facts digest ours base reason push target
  # Docker's base images as read: "<php> <release>" lines, so each is asked about once.
  local bases=''
  : "${REPOSITORY:?}" "${MODE:?}"
  stable="$(gh release view --repo "$REPOSITORY" --json tagName --jq .tagName 2>/dev/null)" || stable=''
  local targets=()
  [ -n "$stable" ] && targets+=("$stable")
  # An edge build in progress pushes a fresh image of its own commit: rebuilding the one before it
  # now could put an older commit back under the edge tag.
  if [ "$(gh run list --repo "$REPOSITORY" --workflow deploy.yml --branch main --event push --json status \
    --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null || echo unknown)" = 0 ]; then
    targets+=(edge)
  else
    echo "::notice::An edge build is in progress, or its state is unknown: edge is left to it."
  fi
  for target in "${targets[@]}"; do
    manifest="$(manifest_of "$target")" || { echo "::warning::$target has no manifest.json; skipped"; continue; }
    sha="$(jq -r '.gitSha // empty' <<<"$manifest")"
    [ -n "$sha" ] || { echo "::warning::$target's manifest names no commit; skipped"; continue; }
    while read -r php ref; do
      [ -n "$php" ] || continue
      # Docker's base, once per PHP version whatever the target.
      base="$(awk -v v="$php" '$1 == v { print $2 }' <<<"$bases")"
      if [ -z "$base" ]; then
        base="$(php_of "wordpress:php$php-fpm")"
        bases="$bases"$'\n'"$php ${base:-none}"
      fi
      [ "$base" != none ] && [ -n "$base" ] || { echo "::warning::Could not read wordpress:php$php-fpm; PHP $php skipped"; continue; }
      facts="$(facts_of "$ref" digest)"
      # Not "absent" but "could not tell": a rebuild now would replace an image nobody looked at.
      [ -n "$facts" ] || { echo "::warning::Could not read $ref; skipped"; continue; }
      read -r digest ours <<<"$facts"
      # Edge's images also carry their commit's own tag, which edge installs follow.
      also=''
      [ "$target" = edge ] && also="${ref%-edge}-sha-${sha:0:7}"
      reason=''
      push=true
      if [ "$MODE" = dry-run ]; then
        # One image, checked as Monday's would be and never pushed.
        [ "$target" = "$stable" ] && [ "$php" = "$(jq -r '.images.wordpress | keys | last' <<<"$manifest")" ] || continue
        reason=weekly push=false
      elif newer "$base" "$ours"; then
        reason=php
      elif [ "$MODE" = weekly ]; then
        reason=weekly
      fi
      echo "$target, PHP $php: published $ours, Docker's base $base${reason:+ -> rebuild ($reason)}"
      [ -n "$reason" ] || continue
      entries="$(jq -c --arg target "$target" --arg php "$php" --arg ref "$ref" --arg also "$also" --arg sha "$sha" \
        --arg reason "$reason" --arg current "$ours" --arg digest "$digest" --argjson push "$push" \
        '. + [{target: $target, php: $php, ref: $ref, also: $also, sha: $sha, reason: $reason, current: $current, digest: $digest, push: $push}]' <<<"$entries")"
    done < <(jq -r '.images.wordpress // {} | to_entries[] | "\(.key) \(.value)"' <<<"$manifest")
  done
  {
    echo "matrix=$entries"
    echo "any=$([ "$entries" != '[]' ] && echo true || echo false)"
  } >>"${GITHUB_OUTPUT:-/dev/stdout}"
}

check() {
  local built=$1 published=$2 current=$3 php mods
  php="$(docker run --rm --network none --entrypoint php "$built" -r 'echo PHP_VERSION;')"
  # Older than what is published would be a step back.
  [ "$php" = "$current" ] || newer "$php" "$current" || die "The build has PHP $php; $published has $current."
  mods="$(docker run --rm --network none --entrypoint php "$built" -m)"
  for ext in redis mysqli pdo_mysql; do
    grep -qx "$ext" <<<"$mods" || die "The build has no PHP extension $ext."
  done
  if newer "$php" "$current"; then
    echo "PHP $current -> $php: pushed."
    echo "push=true" >>"${GITHUB_OUTPUT:-/dev/stdout}"
    return
  fi
  docker pull --quiet --platform "linux/$ARCH" "$published" >/dev/null || die "Could not pull $published to compare with."
  if diff <(fingerprint "$published") <(fingerprint "$built") >/tmp/fingerprint.diff; then
    echo "Nothing in it changed: not pushed, so no site is recreated for it."
    echo "push=false" >>"${GITHUB_OUTPUT:-/dev/stdout}"
  else
    echo "Changed packages and extensions (< published, > new):"
    grep '^[<>]' /tmp/fingerprint.diff || true
    echo "push=true" >>"${GITHUB_OUTPUT:-/dev/stdout}"
  fi
}

push() {
  local built=$1 published=$2 digest=$3 also=${4:-} now type
  # Pushed over only if it is still the image the plan read: a release or an edge build that
  # pushed meanwhile has a fresh base of its own, and a newer commit.
  now="$(facts_of "$published" digest | cut -d' ' -f1)"
  if [ "$now" != "$digest" ]; then
    echo "::notice::$published changed since the plan (${now:-unreadable}); not pushed."
    return
  fi
  for ref in "$published" ${also:+"$also"}; do
    docker tag "$built" "$ref"
    docker push --quiet "$ref"
    # One manifest, as build-images.yml publishes them: an attestation list makes an older
    # daemon's pull pick the wrong entry.
    type="$(docker buildx imagetools inspect --raw "$ref" | jq -r '.mediaType // empty')"
    case "$type" in
      *manifest.v1+json | *manifest.v2+json) echo "Pushed $ref." ;;
      *) die "$ref was pushed as $type, not a single image." ;;
    esac
  done
}

case "${1:-}" in
  plan) plan ;;
  php) php_of "${2:?image}" ;;
  check) check "${2:?built image}" "${3:?published image}" "${4:?published PHP}" ;;
  push) push "${2:?built image}" "${3:?published image}" "${4:?published digest}" "${5:-}" ;;
  *) die "usage: $0 plan | php <image> | check <built> <published> <published PHP> | push <built> <published> <digest> [<also>]" ;;
esac
