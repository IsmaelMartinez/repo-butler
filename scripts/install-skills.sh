#!/usr/bin/env bash
# install-skills.sh — wire repo-butler's read-side and write-side skills into
# the local Claude Code skill registry. Idempotent: re-running is safe.
#
# Usage:
#   ./scripts/install-skills.sh                  # symlink both skills
#   ./scripts/install-skills.sh --uninstall      # remove the symlinks
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
    --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

case "$ACTION" in
  install)
    echo "Installing repo-butler skills into $SKILLS_DIR"
    clean_dead_predecessors
    link_skill repo-butler
    link_skill repo-butler-apply
    echo
    echo "Done. Restart your Claude Code session to pick up the new skills,"
    echo "then try /repo-butler for the morning briefing."
    ;;
  uninstall)
    echo "Removing repo-butler skills from $SKILLS_DIR"
    unlink_skill repo-butler
    unlink_skill repo-butler-apply
    ;;
esac
