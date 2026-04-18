# Forge iOS Version History

Track every version + build number submitted to App Store Connect.
**Before building production, check this file to avoid duplicate build numbers.**

| Version | Build | Date Submitted | Status | Notes |
|---------|-------|---------------|--------|-------|
| 1.0.1   | 1     | 2026-04-07    | Submitted | Initial submission |
| 1.0.1   | 3     | 2026-04-07    | Submitted | Rebuild |
| 1.0.2   | 3     | 2026-04-08    | Submitted | |
| 1.0.2   | 3     | 2026-04-10    | Submitted | Re-submitted |
| 1.0.2   | 3     | 2026-04-17    | REJECTED  | Duplicate build number — Apple blocked it |
| 1.0.3   | 1     | 2026-04-17    | PENDING   | Fresh version bump to avoid conflicts |

## Rules
- **Always increment version OR build number** before a new production build
- Apple rejects duplicate (version + buildNumber) pairs — once submitted, that combo is burned forever
- After every successful submission, update this table
- buildNumber resets to 1 when version increments
