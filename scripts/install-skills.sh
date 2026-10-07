#!/usr/bin/env bash
# install-skills.sh — wire repo-butler's read-side and write-side skills into
# the local Claude Code skill registry, and install the comic mod for sessions
# opened in this checkout. Idempotent:
# re-running is safe.
#
# Usage:
#   ./scripts/install-skills.sh                  # symlink the skills, install the mod
#   ./scripts/install-skills.sh --uninstall      # remove both
#   ./scripts/install-skills.sh --skills-dir DIR # override the target dir
#
# Default target: $HOME/.claude/skills (which is symlinked to $HOME/.claude-home/skills
# on Claude Code installations — the script follows whichever path you have).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="${HOME}/.claude/skills"
ACTION="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION="uninstall"; shift ;;
    --skills-dir)
      if [ $# -lt 2 ]; then echo "Error: --skills-dir requires an argument" >&2; exit 2; fi
      SKILLS_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$REPO_DIR/skills/repo-butler" ] || [ ! -d "$REPO_DIR/skills/repo-butler-apply" ]; then
  echo "Skill sources not found in $REPO_DIR/skills — is this script being run from a checkout that has the consolidated skills (post PR #184/#183)?" >&2
  exit 1
fi

if [ ! -d "$SKILLS_DIR" ]; then
  echo "Skills directory $SKILLS_DIR does not exist."
  echo "Create it (or pass --skills-dir) and re-run."
  exit 1
fi

link_skill() {
  local name="$1"
  local target="$REPO_DIR/skills/$name"
  local linkpath="$SKILLS_DIR/$name"

  if [ -L "$linkpath" ]; then
    local current
    current=$(readlink "$linkpath")
    if [ "$current" = "$target" ]; then
      echo "  $name: already linked"
      return 0
    fi
    echo "  $name: replacing symlink (was $current)"
    rm "$linkpath"
  elif [ -e "$linkpath" ]; then
    echo "  $name: refusing to clobber existing non-symlink at $linkpath" >&2
    return 1
  fi
  ln -s "$target" "$linkpath"
  echo "  $name: linked -> $target"
}

unlink_skill() {
  local name="$1"
  local linkpath="$SKILLS_DIR/$name"
  if [ -L "$linkpath" ]; then
    rm "$linkpath"
    echo "  $name: removed symlink"
  elif [ -e "$linkpath" ]; then
    echo "  $name: not a symlink (manual cleanup needed)"
  else
    echo "  $name: not present"
  fi
}

# Clean up dead symlinks from earlier butler-briefing/butler-debrief layouts
# so a fresh install doesn't trip over them.
clean_dead_predecessors() {
  for name in butler-briefing butler-debrief butler-apply; do
    local linkpath="$SKILLS_DIR/$name"
    if [ -L "$linkpath" ] && [ ! -e "$linkpath" ]; then
      rm "$linkpath"
      echo "  $name: removed dead predecessor symlink"
    fi
  done
}

# The comic mod loads only in this checkout: the repo root is a plugin
# marketplace (.claude-plugin/marketplace.json) and the plugin is installed at
# local scope, which Claude Code keys to this directory. A project-scoped
# marketplace cannot be committed instead, because its path is recorded
# absolute. Local scope installs a cached copy keyed to the checkout's HEAD
# commit (plugin.json deliberately has no version, which would pin it), so a
# re-run after a pull refreshes it; uncommitted edits do not reach it.
install_comic() {
  # Drop the global symlink an earlier installer made, CLI or not.
  unlink_skill repo-butler-comic >/dev/null
  if ! command -v claude >/dev/null 2>&1; then
    echo "  repo-butler-comic: skipped (claude CLI not on PATH)"
    return 0
  fi
  (
    cd "$REPO_DIR"
    claude plugin marketplace update repo-butler >/dev/null 2>&1 ||
      claude plugin marketplace add ./ --scope local >/dev/null
    claude plugin update repo-butler-comic@repo-butler --scope local >/dev/null 2>&1 ||
      claude plugin install repo-butler-comic@repo-butler --scope local >/dev/null
  )
  echo "  repo-butler-comic: installed for sessions in $REPO_DIR"
}

uninstall_comic() {
  unlink_skill repo-butler-comic >/dev/null
  if ! command -v claude >/dev/null 2>&1; then
    echo "  repo-butler-comic: skipped (claude CLI not on PATH)"
    return 0
  fi
  (
    cd "$REPO_DIR"
    claude plugin uninstall repo-butler-comic@repo-butler --scope local >/dev/null 2>&1 || true
    claude plugin marketplace remove repo-butler >/dev/null 2>&1 || true
  )
  echo "  repo-butler-comic: removed"
}

case "$ACTION" in
  install)
    echo "Installing repo-butler skills into $SKILLS_DIR"
    clean_dead_predecessors
    link_skill repo-butler
    link_skill repo-butler-apply
    install_comic
    echo
    echo "Done. Restart your Claude Code session to pick up the new skills,"
    echo "then try /repo-butler for the morning briefing."
    echo
    echo "repo-butler-comic is a mod (a plugin with a hooks module) that draws the"
    echo "briefing as a colour comic. It loads as repo-butler-comic@repo-butler in"
    echo "sessions opened in this checkout; elsewhere the skill falls back to ASCII."
    echo "It is a cached copy of the current commit, so re-run this script after"
    echo "pulling a change to the mod."
    echo
    echo "These are symlinks, so the skill that runs is whatever is in THIS"
    echo "checkout's working tree — not whatever is on main. Check with:"
    echo "  node \"$REPO_DIR/scripts/check-skills.js\""
    ;;
  uninstall)
    echo "Removing repo-butler skills from $SKILLS_DIR"
    unlink_skill repo-butler
    unlink_skill repo-butler-apply
    uninstall_comic
    ;;
esac
