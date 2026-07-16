# Hermes product/privacy review: Forged Hybrid Phase 4D private group runs

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15
Review range: `f326e4f4..HEAD`

Read `CLAUDE.md`, `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md`, and the Phase 4D source. Treat Claude's code/security QA as a separate gate. Do not edit, commit, push, deploy, run EAS, or mutate production data.

Phase 4D adds a private friends-only group-run loop:

- a two-step planner attaches a structured run workout, bounded meetup details, selected accepted friends, and an optional static route;
- invited athletes review the workout, privacy disclosure, and broad meetup area before joining;
- exact meetup instructions and route coordinates unlock only for joined attendees;
- attendees can mute, leave, report, or block; organizers can invite, remove, cancel, or complete;
- cancelling or reaching the retention deadline purges exact meetup and route material;
- scheduled reminders appear only for joined, unmuted athletes;
- compatibility compares the group workout with the athlete's scheduled plan but never changes that plan;
- starting the group run reuses the active-run recorder without writing training-plan progress;
- no live location sharing, public event directory, native notification, or EAS build is included.

Local evidence:

- focused Phase 4D backend/frontend smokes, prior Friends/Challenges regressions, run-integrity smokes, transactional account-deletion smoke, 54-table account coverage, frontend build/audit, and Capacitor sync pass;
- the real planner was inspected at 375x812 with no horizontal overflow, 44px controls, accessible dialogs, Escape close, and focus restoration;
- the disposable three-account matrix covers friendship, invitations, exact-detail gating, join, opaque moderation/owner actions, blocking, cancellation redaction, private/no-store headers, and cleanup.

## Review questions

1. Is the two-step planner simple enough for a friend beta, and is any field unnecessary?
2. Does review-before-join communicate the attendee-name and exact-location tradeoff clearly enough?
3. Is broad meetup area before join plus exact instructions after join the right privacy boundary?
4. Are mute, leave, report, block, remove, cancel, and complete sufficient controls for this beta?
5. Is the retention policy appropriately short and understandable, and should any user-facing copy change before ship?
6. Does the compatibility explanation help without implying the group workout overrides the adaptive plan?
7. Is placing `Runs | Challenges | Friends` inside Community clear without creating social noise?
8. Does the feature create pressure to expose live location or public events before the safety model is ready?
9. What product, trust, privacy, accessibility, or competitive issue might code/security QA miss?

Return exactly one verdict: `APPROVE`, `APPROVE WITH CHANGES`, or `REJECT`. List must-fix items first, optional follow-ups second, and give a concise reason. No EAS is authorized.
