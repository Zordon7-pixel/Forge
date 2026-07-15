# Hermes review: Forged Hybrid Phase 4B private challenge engine

Review the current uncommitted Phase 4B diff in `/Volumes/Zordon Storage /openclaw-workspace/forge-app` after reading `CLAUDE.md`, `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md`, and `.build-prompts/FORGED-HYBRID-PHASE-4B-CLAUDE-QA.md`.

This is a product, privacy, abuse-safety, competitive-integrity, and mobile-UX review. Do not edit files, push, deploy, or run EAS.

The approved Phase 4B direction is:

- private challenges only among accepted friends;
- five deterministic 7/14/30-day templates, including a true hybrid run-plus-strength target;
- source-row scoring with visible manual/device provenance and no LLM scoring;
- challenge participation never changes the adaptive training plan or recovery safeguards;
- blocked shared members remain in official ranking but are mutually anonymous;
- no public discovery, feed, prizes, weight/calorie/health leaderboards, live location, or group runs;
- Challenges is the default Community tab; friend discovery remains separate and intact;
- full leaderboard/detail presentation is Phase 4C, but Phase 4B must provide a coherent create/invite/join/progress loop.

Challenge assumptions around whether the templates are understandable, targets encourage unsafe volume, manual-versus-device policy is clear, hybrid scoring is fair, owner/member controls are sufficient, the default tab adds clutter, and any response could expose sensitive training or identity data. Inspect the backend and frontend at 320px-430px widths.

Return:

1. APPROVE or BLOCK.
2. Findings ordered by severity with exact `file:line` evidence.
3. Must-fix items before beta deployment.
4. What should remain deferred to Phase 4C/4D.
5. Optional later improvements clearly separated from this ship decision.
