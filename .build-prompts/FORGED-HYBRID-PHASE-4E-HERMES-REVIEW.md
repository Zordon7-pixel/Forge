# Hermes product review: Forged Hybrid Phase 4E and follow-up remediation

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-16
Review range: `c5c2dc3f..HEAD`

Read `CLAUDE.md`, `.build-prompts/FORGED-HYBRID-PHASE-4E-WHATS-NEW-SPEC.md`, and the four commits in the review range. Treat Claude Code's code/security QA as a separate gate. Do not edit, commit, push, deploy, run EAS, or mutate production data.

This batch adds and changes four product surfaces:

- Phase 4E introduces a bounded What's New sheet, a permanent archive in More, and quiet unread state so beta users can understand meaningful releases without seeing a changelog on every launch.
- Time PR edits now persist and override derived results for the matching standard distance. PR Wall also supports normal accessibility zoom and narrow-phone layout.
- Train removes evidence/reference exposition and makes the adaptation explanation collapsible. Body prioritizes readiness history/actionable drivers while health-source administration lives in More.
- Run detail gains a Workout match section that compares a completed run with the exact scheduled prescription saved at completion/import time. It refuses ambiguous or inferred matches and explains when only recorded data exists.

Local browser evidence at 390x844:

- the release modal closes on browser back without leaving Today;
- the archive and More entry render without overflow;
- PR Wall has `scrollWidth === innerWidth === 390` and allows zoom from 0.5x to 5x;
- Train no longer shows the removed evidence/reference blocks;
- Body's no-data state routes health setup to More;
- an old run with no target says that no plan target was saved and does not manufacture adherence.

## Review questions

1. Does the first What's New release explain the new community experience clearly enough without interrupting normal use?
2. Are the modal actions, dismissal semantics, archive placement, and unread treatment appropriate for a friend beta?
3. Is PR Wall now understandable and usable on a phone, and does editing a time PR have the right affordance and feedback?
4. Did Train and Body become meaningfully quieter, or is any remaining copy/control still redundant?
5. Is “Workout match” the right product language? Does the score/cue help an athlete improve without sounding punitive or falsely precise?
6. Is exact-date, one-run-only matching appropriately conservative? What should the UI say when an import cannot be matched safely?
7. Does moving sync administration to More preserve discoverability while keeping Body focused?
8. What product, trust, accessibility, or competitive issue might code/security QA miss?
9. Are any of these changes too noisy or too hidden for beta users?

Return exactly one verdict: `APPROVE`, `APPROVE WITH CHANGES`, or `REJECT`. List must-fix items first, optional follow-ups second, and give a concise reason. No EAS is authorized.
