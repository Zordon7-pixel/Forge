# Forge Weekly Run Brief

## Product intent

The Weekly Run Brief turns the current authenticated training plan into a compact, coach-like weekly story. It is a deterministic presentation layer over existing plan, Gear, completion, adaptation, and saved heart-rate data. It does not generate, rebuild, or mutate a plan.

Forge should feel adaptive, premium, and enjoyable without resembling an AI prompt or chat transcript. The weekly surface presents only the next useful decision; advanced rationale stays collapsed.

## Source comparison

| Need | Existing source before this feature | Gap closed by this feature |
| --- | --- | --- |
| Weekly structure | `planCalendar.js` normalized weeks and days | No compact date range, weekly purpose, total miles/time, or training mix |
| Daily execution | `ForgedDayView.jsx` already rendered run, lift, HYROX, Watch/FIT, start, log, and removal controls | No scannable seven-day summary, mission card, Must do/optional separation, or collapsed rationale |
| Run recipe | `runFacts()` already preserved warm-up, structure, recovery, cooldown, pace, zone, duration, and distance | Recipe was available only after opening a day and lacked a weekly entry point |
| Strength details | `liftFacts()` already preserved exact exercise sets, reps, load, RPE/RIR, rest, and cues | No weekly summary and no explicit Must do context |
| Footwear | Authenticated `/gear/shoes` returns the user's active Gear inventory and mileage | Calendar did not select a primary/alternate pair, explain the choice, or warn about wear/surface/rotation |
| Heart rate | Authenticated `/profile/hr-zones` returns a saved profile and computed zones | Calendar showed plan zone text but no fail-closed personalized BPM range |
| Adaptation | Normalized session state identifies adjusted sessions; saved `adjustmentReason` / `adjustment_reason` carries attribution evidence | Saved evidence is surfaced as “Forge adjusted this because…” only after an actual adjustment; generic `whyToday` and local integrity repair are not attributed as coaching changes |
| Safety | Existing injury/check-in flows remain authoritative | No visible if/then pain, soreness, and unexpectedly-hard-effort guardrails beside the workout |
| Accessibility | Calendar had a responsive card layout | Several controls were below 44 px and the weekly information lacked a narrow-screen disclosure strategy |

## Truth and privacy rules

- Weekly totals are derived from normalized sessions. If any included run distance is estimated, the weekly total retains an estimate marker.
- Shoe names, mileage, surface, categories, and intent tags come only from the signed-in user's current Gear inventory. Forge never invents a brand or model.
- Retired, inactive, or at/over-estimate shoes are not selected. Missing or failed Gear data produces a clear no-guess fallback.
- Numeric BPM appears only when a saved profile and all five valid zones support the plan's requested zone. Contiguous computed boundaries are valid, LTHR zone 5 may be open-ended, and malformed/overlapping zones fail closed to plan-native effort language.
- “Forge adjusted this because…” appears only for a session already marked adjusted and uses its saved reason.
- Prescribed HYROX transition rest and run/lift recovery keep source-truthful labels; “Optional” is reserved for an explicitly optional day block.
- Shoe-match wording requires supporting category or intent tags. A fallback pair is labeled closest available and its missing intended category is disclosed.
- The feature performs read-only requests and does not update a plan, Gear, HR profile, completion state, or personal data by itself.

## Progressive disclosure

The week view contains only the weekly story, total target, training mix, Today's mission, and seven day cards with session, distance/time, intensity, primary shoe, and readiness/completion. Opening a day reveals the exact recipe, trusted targets, primary and alternate footwear reasoning, Watch/FIT and start/log actions, and collapsed safety/rationale sections. No horizontal table is used on mobile.

Motion is restrained and disabled under `prefers-reduced-motion`. Interactive controls maintain at least 44 px targets, readable contrast, text wrapping, and semantic labels.

## Music companion boundary

This beta adds no Spotify or Apple Music authentication, streaming, autoplay, or SDK dependency. Forge workout cues and timers should coexist with system audio, use respectful ducking/resume behavior when native audio cues are involved, and never replace system lock-screen media controls. A later separately scoped product lane may consider workout-type playlist deep links or curated Forge playlists.

## Verification contract

- Pure deterministic smoke coverage for totals/mix, classification, Gear-only recommendations, wear/surface warnings, fail-closed Gear, trusted HR, and real-adaptation-only explanations.
- Narrow-screen authenticated browser coverage at 320 px and 393 px for seven-day readability, no horizontal overflow, 44 px actions, recipe disclosure, trusted HR, Gear reasoning, safety rules, exact strength/mobility sets/reps/RPE/rest, and retained Watch/FIT/start controls.
- Full frontend/backend smoke suites, frontend production build, full authenticated/mobile browser suite, service-worker browser suite, and iOS native contract before independent QA.
