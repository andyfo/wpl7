#!/usr/bin/env bash
# The steps of .github/workflows/site-images-refresh.yml, which keeps the published site images on
# the newest PHP without a WPL7 release.
#
#   plan                            which images to rebuild: JSON for the build matrix
#   php <image>                     the PHP release in an image's linux/amd64 build
#   check <built> <published> <reason> <expected PHP>
#                                   whether the build is worth pushing: true or false
#   push <built> <published> <target> <commit>
#
# Needs docker with buildx, jq and gh. Reads REPOSITORY (owner/name), MODE (php, weekly or
# dry-run) and GH_TOKEN from the environment.
set -euo pipefail

PLATFORM_ARCH=amd64
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

# The PHP release in an image's linux/amd64 build, read from the registry without a pull: the
# list, then that one image. Two manifest requests, which is what Docker Hub counts. Empty when
# there is no such image.
php_of() {
  local ref=$1 raw digest
  raw="$(docker buildx imagetools inspect --raw "$ref" 2>/dev/null)" || return 0
  if jq -e '.manifests' >/dev/null <<<"$raw"; then
    digest="$(jq -r --arg arch "$PLATFORM_ARCH" '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch)][0].digest // empty' <<<"$raw")"
    [ -n "$digest" ] || return 0
    ref="${ref%:*}@$digest"
  fi
  docker buildx imagetools inspect --format '{{json .Image}}' "$ref" 2>/dev/null |
    jq -r '.config.Env // [] | map(select(startswith("PHP_VERSION="))) | first // "" | sub("^PHP_VERSION="; "")'
}

fingerprint() {
  docker run --rm --network none --entrypoint sh "$1" -c "$FINGERPRINT"
}

# The release's manifest, as update.sh reads it: its commit and its site images.
manifest_of() {
  gh release download "$1" --repo "$REPOSITORY" --pattern manifest.json --output - 2>/dev/null
}

plan() {
  local stable entries='[]' manifest sha php ref base ours reason push target targets
  : "${REPOSITORY:?}" "${MODE:?}"
  stable="$(gh release view --repo "$REPOSITORY" --json tagName --jq .tagName 2>/dev/null)" || stable=''
  targets=()
  [ -n "$stable" ] && targets+=("$stable")
  # An edge build in progress pushes a fresh image of its own commit: rebuilding the one before it
  # now could put an older commit back under the edge tag.
  if [ "$(gh run list --repo "$REPOSITORY" --workflow deploy.yml --branch main --event push --json status \
    --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null || echo 1)" = 0 ]; then
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
      base="$(php_of "wordpress:php$php-fpm")"
      [ -n "$base" ] || { echo "::warning::Could not read wordpress:php$php-fpm; PHP $php skipped"; continue; }
      ours="$(php_of "$ref")"
      reason=''
      push=true
      if [ "$MODE" = dry-run ]; then
        # One image, checked as Monday's would be and never pushed.
        [ "$target" = "$stable" ] && [ "$php" = "$(jq -r '.images.wordpress | keys | last' <<<"$manifest")" ] || continue
        reason=weekly push=false
      elif [ -z "$ours" ] || newer "$base" "$ours"; then
        reason=php
      elif [ "$MODE" = weekly ]; then
        reason=weekly
      fi
      echo "$target, PHP $php: published ${ours:-none}, Docker's base $base${reason:+ -> rebuild ($reason)}"
      [ -n "$reason" ] || continue
      entries="$(jq -c --arg target "$target" --arg php "$php" --arg ref "$ref" --arg sha "$sha" --arg reason "$reason" \
        --arg expected "$base" --argjson push "$push" \
        '. + [{target: $target, php: $php, ref: $ref, sha: $sha, reason: $reason, expected: $expected, push: $push}]' <<<"$entries")"
    done < <(jq -r '.images.wordpress // {} | to_entries[] | "\(.key) \(.value)"' <<<"$manifest")
  done
  {
    echo "matrix=$entries"
    echo "any=$([ "$entries" != '[]' ] && echo true || echo false)"
  } >>"${GITHUB_OUTPUT:-/dev/stdout}"
}

check() {
  local built=$1 published=$2 reason=$3 expected=$4 php
  php="$(docker run --rm --network none --entrypoint php "$built" -r 'echo PHP_VERSION;')"
  # Docker's base may have moved on since the plan: newer is as good.
  [ "$php" = "$expected" ] || newer "$php" "$expected" || die "The build has PHP $php; Docker's base had $expected."
  for ext in redis mysqli pdo_mysql; do
    docker run --rm --network none --entrypoint php "$built" -m | grep -qx "$ext" || die "The build has no PHP extension $ext."
  done
  if [ "$reason" != weekly ]; then
    echo "PHP $php: pushed."
    echo "push=true" >>"${GITHUB_OUTPUT:-/dev/stdout}"
    return
  fi
  docker pull --quiet --platform "linux/$PLATFORM_ARCH" "$published" >/dev/null || die "Could not pull $published to compare with."
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
  local built=$1 published=$2 target=$3 sha=$4 now
  if [ "$target" = edge ]; then
    # A newer edge build has an image of its own, made on a fresh base: leave it.
    now="$(manifest_of edge | jq -r '.gitSha // empty')"
    if [ "$now" != "$sha" ]; then
      echo "::notice::edge has moved on to ${now:-an unknown commit}; not pushed."
      return
    fi
  fi
  docker tag "$built" "$published"
  docker push --quiet "$published"
  echo "Pushed $published."
}

case "${1:-}" in
  plan) plan ;;
  php) php_of "${2:?image}" ;;
  check) check "${2:?built image}" "${3:?published image}" "${4:?reason}" "${5:?expected PHP}" ;;
  push) push "${2:?built image}" "${3:?published image}" "${4:?target}" "${5:?commit}" ;;
  *) die "usage: $0 plan | php <image> | check <built> <published> <reason> <expected PHP> | push <built> <published> <target> <commit>" ;;
esac
