# FORGE-RELEASE-CHECKLIST.md

Use this for frontend/mobile-facing fixes so "patched in source" does not get confused with "actually shipped and confirmed live."

## Core rule

A source change is not shipped just because code was edited locally or merged. A Forge fix is only verified fixed after deployment succeeds, production behavior is checked on the live app/site, and Bryan confirms the real-world issue is resolved.

## Required status language

Use only these exact statuses in handoff notes, QA notes, or release updates:

- patched — code changed locally/in repo, not yet confirmed deployed live
- shipped — deploy/build completed successfully, but live behavior still needs verification
- awaiting verification — deploy/build is out, but Bryan or live-device QA has not yet confirmed the fix
- verified fixed — live production behavior checked and Bryan has confirmed the issue is resolved

Do not say "fixed" by itself for mobile-facing changes.

## Release checklist

### 1) Source patched
- [ ] Diff is complete and intentional
- [ ] Scope is bounded to the requested fix
- [ ] Any user-visible route/navigation changes were tested locally at least once
- [ ] Status recorded as `patched`

### 2) Railway deploy must succeed
- [ ] Change is pushed to the branch/environment that Railway deploys from
- [ ] Railway build finishes successfully
- [ ] Railway deploy finishes successfully
- [ ] If Railway fails, status stays `patched` and is not called shipped

### 3) Live production behavior must be checked
- [ ] Open the live production site/app after deployment
- [ ] Confirm the exact user-visible behavior that was reported
- [ ] Confirm no obvious regression on the same surface
- [ ] If production was not checked yet, use `shipped` or `awaiting verification`, not `verified fixed`

### 4) Mobile-facing artifact must be recorded
For any change that affects iPhone/TestFlight/React Native/webview-visible behavior:
- [ ] Record app version/build number or web release identifier
- [ ] Record TestFlight build number if applicable
- [ ] Record date/time of the deployed artifact checked
- [ ] Record who checked it and on what device/app surface

Suggested log format:

```text
Artifact: vX.Y.Z (build N) / TestFlight build N / Railway deploy <timestamp or commit>
Surface: iPhone app / mobile web / desktop web
Checked by: <name>
Status: patched | shipped | awaiting verification | verified fixed
```

### 5) Bryan verification gate
- [ ] Bryan has checked the real production behavior for the reported issue
- [ ] Bryan explicitly confirms resolved, or a delegated live QA owner does and Bryan is informed
- [ ] Only then upgrade status to `verified fixed`

## Practical handoff template

```text
Issue:
Change made:
Status: patched | shipped | awaiting verification | verified fixed
Railway deploy: not started | failed | succeeded
Production check: not run | failed | passed
Artifact/version/build:
Bryan verification: pending | complete
Notes:
```

## Example decision guide

- Code edited locally, no deploy yet -> `patched`
- Railway deploy succeeded, nobody checked live behavior yet -> `shipped`
- Railway deploy succeeded, Bryan still needs to test on his phone -> `awaiting verification`
- Bryan checked production and confirmed it works -> `verified fixed`
