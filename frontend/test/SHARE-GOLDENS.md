# C1+C2 canonical goldens

Session 2 changes the harness, not the images. `acceptance-v2.json` is explicitly
`pending`, with a pinned source/font/fixture/render fingerprint and the released
C1 Chromium 151 / Playwright 1.62.1 runtime. Default acceptance MUST fail until
both platform sets exist and a complete candidate is reviewed and pinned.
`linux-diagnosis.json`, its released C1 acceptance, and the original PNGs remain
historical evidence; they are not silently reapproved for changed C2 sources.
The old `--update=<overlay>` / `--compare=<overlay>` switches are rejected.

The unchanged 18 C1 case names precede exactly 18 C2 cases. C1 fixture inputs and
photo/comparator remain intact; Strike PR now displays `44:38 mm:ss`, so all six
Strike PNGs need regeneration on **each** platform. Regenerate and review all 18
C1 cases together. C2 uses real adapter-shaped test records: GPS/elevation for
Trace and Full-Bleed; observed streak history for Forged Days (light=week,
dark=month, color=milestone). No new product stats or legacy IDs are introduced.

## Generation: eight serialized sessions, one command per session

Run from the checkout root, with locked frontend dependencies already installed.
Every session begins clean at the previous Hermes checkpoint. Do not loop the
commands in one session. Generation refuses a dirty checkout, wrong host platform,
unknown/combined filter, duplicate completed batch, CI update, stale fingerprint,
wrong runtime/font, or tampered prior receipt. It renders/tests first, then writes
**at most nine PNG paths plus one platform receipt**. It never edits acceptance or
its pin. Even partial receipts cannot pass acceptance. A crash can leave partial
image writes but cannot create a valid receipt or acceptance; inspect/recover that
same batch before checkpointing, never claim it complete.

Mac requires actual `darwin-arm64`. These are four separate Codex sessions:

```sh
mkdir -p /tmp/forge-c2-golden-home
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/Users/zordon/Library/Caches/ms-playwright node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=1 --platform=darwin-arm64
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/Users/zordon/Library/Caches/ms-playwright node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=2 --platform=darwin-arm64
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/Users/zordon/Library/Caches/ms-playwright node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=3 --platform=darwin-arm64
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/Users/zordon/Library/Caches/ms-playwright node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=4 --platform=darwin-arm64
```

Linux requires an **actual Linux x64 host/container** using the locked dependencies
and Chromium revision 1234 with system libraries. Set up that host's explicit
browser cache at `/tmp/forge-c2-pw` before generation (outside this implementation
session). Do not copy Mac images into Linux's directory. Four separate sessions:

```sh
mkdir -p /tmp/forge-c2-golden-home
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/tmp/forge-c2-pw node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=1 --platform=linux-x64
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/tmp/forge-c2-pw node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=2 --platform=linux-x64
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/tmp/forge-c2-pw node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=3 --platform=linux-x64
HOME=/tmp/forge-c2-golden-home PLAYWRIGHT_BROWSERS_PATH=/tmp/forge-c2-pw node frontend/test/shareOverlaysC1.smoke.mjs --update-batch=4 --platform=linux-x64
```

Paths relative to `frontend/test/goldens/share-c1/`:
Mac writes `./<case>.png` and `generation-v2.json`; Linux writes
`linux-x64-chromium-151-no-hint/<case>.png` and that directory's `generation-v2.json`.
Theme order is light/dark/color, each feed then story. Batch inventory per platform:

| Batch | Nine PNG cases |
| --- | --- |
| 1 | all six iron-chips; strike-pr light-feed, light-story, dark-feed |
| 2 | strike-pr dark-story, color-feed, color-story; all six hybrid-split |
| 3 | all six trace; forged-days light-feed, light-story, dark-feed |
| 4 | forged-days dark-story, color-feed, color-story; all six full-bleed-story |

All eight batches remain after session 2. A batch receipt records the actual
platform, exact runtime, fingerprints, nine PNG hashes/dimensions, and batch ID.
Later batches recheck earlier bytes. No partial receipt or unreviewed generated
set is a passing baseline. Sources must stay frozen throughout generation;
a source/font/render change invalidates the receipts and needs fresh generation.

## Assembly, review and final validation (separate session)

After both sets and receipts are checkpointed together, assemble a candidate at a
new external path. This validates all 72 PNG hashes/dimensions, exact directories,
all eight batches, both platforms and the current source/font/fixture/render
fingerprint. No Chromium or acceptance mutation is performed by assembly:

```sh
node frontend/test/shareOverlaysC1.smoke.mjs --candidate=/tmp/forge-share-acceptance-v2.json
```

Hermes retains raw actual-platform generation receipts/logs and coordinates review.
In a later authorized Codex session, copy the assembled candidate to
`frontend/test/goldens/share-c1/acceptance-v2.json` and its printed SHA-256 plus a
newline to `acceptance-v2.sha256` (two paths). Pinning a candidate alone is not QA.
Run default comparison on **both actual platforms**, with their isolated HOME and
browser paths as above. Also run `--compare=c1` on both so all C1 changes, including
Strike PR, are reviewed together. `--compare=c2` is available for diagnosis; every
comparison still requires BOTH complete 36-file manifests, never a partial set.

```sh
node frontend/test/shareOverlaysC1.smoke.mjs
node frontend/test/shareOverlaysC1.smoke.mjs --compare=c1
node frontend/test/shareGoldenProvenance.smoke.mjs
node frontend/test/activityShareStudioFramework.smoke.mjs
```

Tolerance remains <=0.1% of RGBA pixels, exact 1080x1350/1080x1920 dimensions, four
loaded bundled font faces, safe Story content bounds, transparent-overlay alpha,
opaque photo composites, PNG/JPEG decoded export dimensions, deterministic rerender
and comparator mutation/dimension negatives. The existing CI discovers both
provenance and optional-stat oracle smoke tests without workflow/config changes.

Offline-only checks: `--filter-only`, `shareOverlaysC2.smoke.mjs`,
`shareOptionalStatsOracle.smoke.mjs`, `shareGoldenProvenance.smoke.mjs`.
`--smoke` runs 36 browser cases without reading/writing goldens and never claims
acceptance. Session 2 full framework startup was blocked by missing local `vite`
(exit 1); isolated-HOME host Chromium rerun remains required.
