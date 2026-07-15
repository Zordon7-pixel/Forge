# Hermes product/safety review: Forged Hybrid Phase 4C leaderboard and beta polish

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15

Read `CLAUDE.md`, `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md`, the current Phase 4C diff, and Claude Code's QA output summarized by Codex before answering. Do not edit, commit, push, deploy, or run EAS.

Phase 4C adds the missing private challenge detail experience:

- joined-member leaderboard with tied ranks, percent/progress, in-app/device source labels, and bounded recent activity;
- blocked shared members remain rank-only and reveal no identity/progress/activity;
- loading, retry, empty, and no-activity states;
- owner member-removal through an opaque membership ID, plus non-owner challenge reporting;
- clear strength-credit policy: completed Forged Hybrid workout sessions and trusted device sessions count; ambiguous legacy exercise-only lift rows remain in private History but do not score socially;
- legitimate same-day two-a-days remain distinct by canonical IDs;
- known bounded beta limitation is documented: an in-app lift later imported independently from a watch may count twice until a shared source identity exists;
- compact links to log a run/start a lift without allowing challenges to override adaptive-plan safety.

Local evidence already available:

- focused Phase 4B and Phase 4C scoring smokes pass;
- 53-table account-data coverage passes;
- frontend build and high-severity audit pass;
- the real local UI was inspected at 375x812 and 430x932;
- a reusable three-account API matrix passed friendship, private invite/join, ties, canonical-versus-legacy strength identity, user-ID privacy, member reporting, owner removal, nonmember 404, and disposable-account cleanup.

Review questions:

1. Does this complete the minimum safe/private Challenge beta loop for friends?
2. Is the strength-credit policy understandable and fair enough for beta?
3. Does recent activity reveal too much, too little, or the right bounded detail?
4. Are mute, report, leave, cancel, and owner removal sufficient moderation controls before friend beta testing?
5. Is the in-app-plus-watch residual over-count acceptable if explicitly documented, or must it block Phase 4C?
6. Is the challenge detail too noisy on mobile, and should anything be removed or reordered before shipping?
7. Do you see any product, trust, privacy, safety, or competitive issue that Claude's code/security QA may miss?

Return exactly one verdict: `APPROVE`, `APPROVE WITH CHANGES`, or `REJECT`. Then list must-fix items first, optional follow-ups second, and a concise reason. Phase 4D group runs remains separate. No EAS is authorized.
