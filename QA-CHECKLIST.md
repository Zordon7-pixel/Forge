# QA-CHECKLIST.md — Forge

Run through every item for every diff. CRITICAL items block ship. HIGH items must be noted in report.

---

## CRITICAL — Block ship if any are true

- [ ] DELETE or UPDATE query missing `AND user_id=?` ownership check
- [ ] User input string-interpolated into SQL (not parameterized)
- [ ] New route missing `auth` middleware
- [ ] User-controlled field passed raw into AI prompt (no sanitize() call)
- [ ] Hardcoded user ID in query
- [ ] `catch` block that swallows errors silently
- [ ] JWT secret or API key logged or returned in response
- [ ] Sonnet used on a function that fires on every run/lift log

## HIGH — Flag in report, must fix before next build

- [ ] New numeric input field with no range validation
- [ ] Email field with no format validation
- [ ] Password field with no minimum length check
- [ ] Missing null check before `.property` access on DB result
- [ ] New AI prompt function without model explicitly set
- [ ] New async function with no try/catch

## MEDIUM — Note in report

- [ ] AI prompt that could produce robotic/generic output (check tone matches coaching voice)
- [ ] Error message leaks internal details
- [ ] React Native: form submit with no loading state
- [ ] React Native: no keyboard dismiss on submit
- [ ] Unused import or variable

---

## Forge-Specific Patterns to Watch

- `sanitize()` — must wrap ALL user fields in AI prompts: name, notes, exercise, distance, pace
- Model tier — `claude-haiku-4-5` for per-action feedback, `claude-sonnet-4-6` for plans/insights only
- Lift weight — must validate `> 0` (not `>= 0`, not `> -1`)
- `perceived_effort` — must validate 1–10 range
- Profile updates — age (10–110), weight_lbs (50–700), max_heart_rate (100–220)
