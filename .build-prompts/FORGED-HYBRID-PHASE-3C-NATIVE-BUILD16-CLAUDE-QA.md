# Claude Code QA: Forged Hybrid Phase 3C iOS build 16 preflight

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Review current `main` as a read-only release gate before one EAS production iOS build. Do not edit files, commit, push, deploy, submit, or run any EAS cloud build. Read `CLAUDE.md` first.

## Scope

Phase 3C advances the native TestFlight shell from build 15 to build 16 so the already-merged custom Apple Watch WorkoutKit bridge registration is included. The intended source diff is limited to:

- `frontend/app.json`: iOS build number 15 -> 16
- `frontend/ios/App/App.xcodeproj/project.pbxproj`: both `CURRENT_PROJECT_VERSION` entries 15 -> 16

Do not ask for changes to the historical `frontend/capacitor.config.ts` `appId` in this release. The committed native Xcode project and App Store identity use `com.zordontech.forge`; successful builds 5-15 already used that native identity.

## Verify

1. Git is on `main`, the only release-source edits are the two build-number files above, and unrelated untracked artifacts are not part of the release.
2. `frontend/app.json` and both Xcode configurations are exactly build 16; version remains 1.0.5; bundle ID remains `com.zordontech.forge`; ASC app ID remains `6759941190`; EAS project ID remains `6aeb5fbb-2697-4cf4-b9b3-afe60c63e9e1`.
3. `frontend/eas.json` production remains store distribution with local app version source and the existing Xcode image. No credential or profile changes.
4. `AppViewController.swift` registers both `ForgeHealthPlugin()` and `ForgeWatchWorkoutPlugin()` and the main storyboard actually uses `AppViewController`.
5. Both custom Swift files are referenced and compiled by the Xcode project. WorkoutKit calls are iOS 17 gated and use clear unsupported/error paths.
6. HealthKit usage strings, location usage strings, `UIBackgroundModes=location`, and `ITSAppUsesNonExemptEncryption=false` are present.
7. `CapApp-SPM/Package.swift` links Capacitor 8.2.0, background geolocation, and `@capacitor/app`; the plugin compatibility patch is present and applied by `postinstall`.
8. The native shell still points to the production Railway URL and no web/backend behavior was changed by this phase.
9. Check for any build-16 blocker, especially duplicate build number, missing source membership, missing entitlement/permission, package-resolution drift, malformed plist, or signing identity inconsistency.

## Completed gates (independently inspect source; do not rerun EAS)

- `npm ci`: pass, compatibility patch applied, 0 vulnerabilities
- `cd frontend && npm run build`: pass, bundle `index-d8g9cyH9.js`
- `cd frontend && npm audit --audit-level=high`: 0 vulnerabilities
- `cd backend && npm run check:account-data`: 49 tables OK
- `cd frontend && npx cap sync ios`: pass; exactly two Capacitor plugins found; no generated tracked diff
- `bash -n scripts/deploy-ios.sh`: pass
- `swiftc -parse` for `ForgeHealthPlugin.swift`, `ForgeWatchWorkoutPlugin.swift`, and `AppViewController.swift`: pass
- all 13 frontend smoke suites: pass
- all 13 backend phase smoke suites: pass
- all 9 standalone backend integrity smokes: pass
- `eas build:inspect` archive: pass; required native files present; no env/database/backend/deploy-script files
- `xcodebuild` resolved the complete SPM graph at Capacitor 8.2.0, then could not compile because this Mac lacks the iOS 26.5 platform and has an out-of-date local CoreSimulator. Treat this as a local environment limitation unless source evidence reveals a separate defect.
- EAS account/project: `zordon`, `@zordon/forge-athlete`, matching project ID; latest build 15 (`798f0bad-353a-4258-9cf4-41b9ac185c69`) finished successfully.

## Output

Return:

1. Verdict: `PASS`, `PASS WITH RISKS`, or `BLOCK`.
2. Findings ordered CRITICAL/HIGH/MEDIUM/LOW with exact file:line evidence.
3. Explicit build-number, bundle/project identity, native registration, package linkage, permissions, and archive verdicts.
4. State whether one non-interactive EAS production build using existing remote credentials is safe to start.

Do not modify anything.
