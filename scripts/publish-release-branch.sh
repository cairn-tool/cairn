#!/bin/sh
# Publish build/release to the `release` branch and tag it.
#
#   ./scripts/publish-release-branch.sh 1.4.0
#
# Called from semantic-release's publish step. `main` is PR-gated by org
# ruleset, so nothing is ever pushed there; `release` carries no branch rules,
# which is what makes this possible.
#
# The commit is a fast-forward on top of the previous release, never a force
# push. Claude Code's background auto-update runs `git pull` inside each user's
# clone of this branch, and a rewritten history would break every existing
# install's update path. Linear history here is load-bearing, not tidiness.
set -eu

if [ $# -ne 1 ]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi
version=$1

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
release="${RELEASE_DIR:-$root/build/release}"
work="$root/build/rel"
branch=release
orphan=_release_build
tag="release-v$version"

[ -d "$release" ] || { echo "publish: $release does not exist; run release-build.sh first" >&2; exit 1; }

# Authenticate the remote inline rather than relying on the checkout's stored
# credentials, so the workflow can keep `persist-credentials: false`.
# RELEASE_REMOTE overrides it, which is how this script is exercised against a
# scratch repository without touching the real one.
if [ -n "${RELEASE_REMOTE:-}" ]; then
  remote=$RELEASE_REMOTE
else
  : "${GITHUB_TOKEN:?publish: GITHUB_TOKEN is required}"
  : "${GITHUB_REPOSITORY:?publish: GITHUB_REPOSITORY is required}"
  remote="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
fi

# An earlier run that exited before `worktree remove` leaves the path deleted
# but still registered, which makes `worktree add` fail with "already exists".
rm -rf "$work"
git -C "$root" worktree prune

# A fetch failure here is not necessarily a missing branch — it may be network
# or auth. Falling through to the orphan path in that case is safe: pushing an
# unrelated history onto an existing branch is rejected as a non-fast-forward
# rather than clobbering it.
if git -C "$root" fetch --quiet "$remote" "$branch" 2>/dev/null; then
  git -C "$root" worktree add --quiet --detach "$work" FETCH_HEAD
else
  echo "publish: $branch does not exist yet, creating it"
  git -C "$root" worktree add --quiet --detach "$work"
  # A scratch name, never `$branch`: `checkout --orphan` refuses a name that
  # already exists locally, so reusing the real branch name would make a second
  # run fail against any clone that happens to have it. The commit is pushed by
  # ref below, so the local name is irrelevant.
  git -C "$work" branch -D "$orphan" 2>/dev/null || true
  git -C "$work" checkout --quiet --orphan "$orphan"
  git -C "$work" rm -rq --cached . 2>/dev/null || true
fi

# Replace the tree wholesale so a plugin or skill deleted upstream disappears
# here too. `.git` in a worktree is a file, not a directory.
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
(cd "$release" && tar cf - .) | (cd "$work" && tar xf -)

git -C "$work" add -A
if git -C "$work" diff --cached --quiet; then
  echo "publish: no change in the release tree; skipping commit"
else
  git -C "$work" \
    -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "chore(release): $version [skip ci]"
  git -C "$work" push --quiet "$remote" "HEAD:refs/heads/$branch"
  echo "publish: pushed $branch @ $version"
fi

git -C "$work" tag -f "$tag"
git -C "$work" push --quiet --force "$remote" "refs/tags/$tag"
echo "publish: tagged $tag"

git -C "$root" worktree remove --force "$work"
git -C "$root" branch -D "$orphan" 2>/dev/null || true
