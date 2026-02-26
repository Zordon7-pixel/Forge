# Task: Smart Step Validation + TestFlight Build Prep for FORGE

## Goal
Two parallel objectives:
1. Add smart form validation across all key user-facing flows
2. Prepare the app for TestFlight submission (build config, icons, metadata)

## Part 1: Smart Step Validation

### Target Screens/Flows
- **Workout logging** (lifts.js / frontend): Validate sets/reps/weight are positive numbers; warn if weight drops >30% from previous session (could be injury risk); require at least 1 set before saving
- **Run logging** (checkin.js): Validate distance > 0, duration > 0; warn if pace is unusually fast/slow (< 4 min/mile or > 20 min/mile)
- **Injury logging** (injury.js): Require body part selection + severity before saving; warn if same injury logged 3+ times in 30 days
- **Check-in / Feeling** (checkin.js): Require at least one feeling selected before proceeding
- **Goal setting**: Validate goal has a name, target value, and target date in the future

### Implementation Pattern
- Add validation helpers to `frontend/src/utils/validation.js` (create if not exists)
- Each form should show inline error messages (red text below the field, not alerts)
- Warnings (non-blocking) should show as amber/yellow inline hints
- On mobile: errors should scroll into view automatically
- No external validation libraries — pure React state

## Part 2: TestFlight / App Store Build Prep

### Check and Fix
1. `app.json` or `expo.json` — verify:
   - `ios.bundleIdentifier` is set (e.g. `com.zordon.forge`)
   - `ios.buildNumber` is set (increment to next value)
   - `version` is correct (e.g. `1.0.0`)
   - `ios.infoPlist` has `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription` if HealthKit used
2. App icons — verify `assets/icon.png` exists at 1024x1024
3. Splash screen — verify `assets/splash.png` exists
4. `eas.json` — create if not exists with preview + production build profiles:
```json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "preview": {
      "distribution": "internal",
      "ios": { "simulator": false }
    },
    "production": {
      "ios": { "enterpriseProvisioning": "universal" }
    }
  }
}
```
5. `package.json` — verify no missing peer deps that would fail EAS build

### Done When
- [ ] Validation helpers created/updated
- [ ] Inline validation working on workout log, run log, injury log, check-in
- [ ] app.json has correct bundle ID and build number
- [ ] eas.json created with build profiles
- [ ] No blocking issues found in build config
- [ ] git add -A && git commit -m "feat: smart step validation + TestFlight build prep"
