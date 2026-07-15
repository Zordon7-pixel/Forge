# Hermes review: Forged Hybrid Phase 4A.1 exact-handle discovery

Review the current uncommitted Phase 4A.1 diff in `/Volumes/Zordon Storage /openclaw-workspace/forge-app` after reading `CLAUDE.md` and `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md`.

This is a product, privacy, abuse-safety, and mobile-UX review. Do not edit files, push, deploy, or run EAS.

The approved direction is:

- finding a known friend in-app should be primary;
- users choose a unique `@handle` and explicitly opt into exact-handle discoverability;
- existing users are hidden by default;
- no fuzzy/name/email/contact search and no browseable directory;
- blocked/hidden/missing/invalid results are indistinguishable;
- mutual requests, acceptance, block, report, and caps remain unchanged;
- private invite links stay as a secondary fallback;
- QR codes and challenges are out of this phase.

Inspect backend behavior and `frontend/src/pages/Community.jsx` at 320px-430px widths. Challenge assumptions around clarity, handle setup, discoverability consent, abuse/enumeration, accidental exposure, duplicate controls, and whether the flow is simpler than link-only invites without becoming a social feed.

Return:

1. APPROVE or BLOCK.
2. Findings ordered by severity with exact `file:line` evidence.
3. Any must-fix item before beta deployment.
4. Optional later improvements clearly separated from this phase.
