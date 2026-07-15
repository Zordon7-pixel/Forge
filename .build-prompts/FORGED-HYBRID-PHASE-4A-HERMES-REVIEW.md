# Hermes Review: Forged Hybrid Phase 4A Friends and Safety

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Read `CLAUDE.md`, `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md`, the current complete working-tree diff, and `.build-prompts/FORGED-HYBRID-PHASE-4A-CLAUDE-QA.md`. Claude Code returned PASS with no critical/high findings; its two actionable low findings (38px controls and backslash redirect hardening) have been fixed.

This is a read-only product, privacy, and beta-usability review. Do not edit files, commit, push, deploy, create accounts, mutate production, or run EAS.

Assess whether Phase 4A is the right minimum foundation for friends-and-family beta:

- private one-use invite links, mutual acceptance, remove, block, and report;
- no public user search, contact upload, feed, messages, challenges, leaderboards, location sharing, or noisy bottom-nav addition yet;
- display-name-only friend lists, no email/health/route/location exposure;
- clean mobile Community screen under More with understandable invite, pending, empty, blocked, report, error, and limit states;
- invite handoff through login/registration/onboarding;
- moderation retention and account export/deletion behavior;
- compatibility with the separately deferred Phase 4B challenge engine.

Return findings first as BLOCKER, SHOULD FIX, or FUTURE. Give exact file:line evidence for code concerns. Then state APPROVE or REJECT for Railway deployment and two-disposable-account live testing. Explicitly confirm that no EAS build is needed or authorized.
