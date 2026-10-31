#!/usr/bin/env bash
set -euo pipefail

# One-time, idempotent setup of Vibe Center's GitHub release pipeline (modelled on Canvas's
# scripts/bootstrap-release.sh, GitHub phase only; npm publishing comes later). Every step checks
# what already exists before acting, so a failure part-way through is fixed by re-running it.
#
# Usage: scripts/bootstrap-release.sh
#
# Run it after the PR that adds .github/workflows/ has merged: branch protection requires the CI
# checks by name, and GitHub only offers names it has seen run.

OWNER="FreshlyBrewedCode"
REPO="vibe-center"
REPO_SLUG="${OWNER}/${REPO}"
ENVIRONMENT="release"
FLOOR_TAG="v0.1.0"
REQUIRED_CHECKS=("check" "voice" "e2e" "lint-title")

log()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    - %s\n' "$1"; }
die()  { printf 'error: %s\n' "$1" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH."
}

log "GitHub: ${REPO_SLUG}"
require_cmd gh
require_cmd git
gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run 'gh auth login' first."
ok "gh is authenticated as $(gh api user -q .login)"

gh repo view "$REPO_SLUG" >/dev/null 2>&1 || die "$REPO_SLUG doesn't exist; create it and push main first."
git ls-remote --exit-code --heads origin main >/dev/null 2>&1 || die "main isn't pushed to origin yet."
gh repo edit "$REPO_SLUG" --default-branch main >/dev/null
ok "main is the default branch"

# Squash-merge only, with the PR title as the commit message: the title is what the PR-title
# check validates and what semantic-release parses.
gh api --method PATCH "repos/${REPO_SLUG}" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY >/dev/null
ok "squash-merge only, PR title as the commit message"

if gh api "repos/${REPO_SLUG}/environments/${ENVIRONMENT}" >/dev/null 2>&1; then
  ok "the '${ENVIRONMENT}' environment already exists"
else
  info "creating the '${ENVIRONMENT}' environment (release.yml runs in it; for npm's OIDC later)"
  gh api --method PUT "repos/${REPO_SLUG}/environments/${ENVIRONMENT}" >/dev/null
fi

info "requiring ${REQUIRED_CHECKS[*]} on main (admins can still push directly)"
contexts=$(printf '"%s",' "${REQUIRED_CHECKS[@]}")
gh api --method PUT "repos/${REPO_SLUG}/branches/main/protection" --input - >/dev/null <<JSON
{
  "required_status_checks": { "strict": true, "contexts": [${contexts%,}] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
ok "branch protection applied"

# .releaserc.json names a `stable` branch because semantic-release rejects a config whose only
# branch is a pre-release branch. Nothing is pushed to or released from it.
if git ls-remote --exit-code --heads origin stable >/dev/null 2>&1; then
  ok "the 'stable' branch already exists"
else
  info "creating 'stable' at main (referenced by .releaserc.json, never released from)"
  git fetch origin main --quiet
  git push origin "origin/main:refs/heads/stable"
fi

# The floor: semantic-release counts versions from the last tag, so history before it (which
# predates the conventional PR titles) never decides a version.
if git ls-remote --exit-code --tags origin "$FLOOR_TAG" >/dev/null 2>&1; then
  ok "$FLOOR_TAG is already tagged"
else
  info "tagging $FLOOR_TAG at main"
  git fetch origin main --quiet
  git tag "$FLOOR_TAG" origin/main
  git push origin "$FLOOR_TAG"
fi

log "Done"
