// Forged Hybrid friends-beta Phase 2 private run-media smoke.
// Run: node backend/test/forgedHybridFriendsPhase2.smoke.js

const fs = require('fs');
const path = require('path');
const {
  MAX_ACTIVITY_PHOTOS,
  defaultMediaVisibility,
  validatePhotoPayload,
} = require('../src/lib/activityMedia');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  }
}

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

console.log('\n== photo boundary validation ==');
const jpegData = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
check(validatePhotoPayload({ data: jpegData, mime_type: 'image/jpeg' }).data === jpegData, 'valid JPEG data URI is accepted');
check(Boolean(validatePhotoPayload({ data: jpegData, mime_type: 'image/png' }).error), 'declared MIME must match the data URI');
check(Boolean(validatePhotoPayload({ data: 'data:image/jpeg;base64,bm90LWEtanBlZw==', mime_type: 'image/jpeg' }).error), 'invalid JPEG signature is rejected');
check(Boolean(validatePhotoPayload({ data: `data:image/jpeg;base64,${'A'.repeat(1000000)}`, mime_type: 'image/jpeg' }).error), 'oversized payload is rejected');
check(MAX_ACTIVITY_PHOTOS === 4, 'server photo limit remains four');
check(defaultMediaVisibility('run') === 'private' && defaultMediaVisibility('lift') === 'private', 'training media defaults private');
check(defaultMediaVisibility('feed') === 'public' && defaultMediaVisibility('community_post') === 'public', 'social media preserves public legacy behavior');

console.log('\n== migration and route scoping ==');
const migrate = read('backend/src/db/migrate.js');
const social = read('backend/src/routes/social.js');
check(migrate.includes('ALTER TABLE activity_media ADD COLUMN IF NOT EXISTS visibility TEXT'), 'visibility migration is idempotent');
check(/SET visibility = CASE[\s\S]*WHERE visibility IS NULL/.test(migrate), 'legacy visibility backfill only touches unset rows');
check(migrate.includes("ALTER TABLE activity_media ALTER COLUMN visibility SET NOT NULL"), 'visibility becomes required after backfill');
check(/SELECT id, mime_type, created_at, visibility[\s\S]*activity_type = \? AND user_id = \?/.test(social), 'collection response is metadata-only and owner scoped');
check(/SELECT id, data, mime_type, created_at, visibility[\s\S]*id = \? AND activity_id = \? AND activity_type = \? AND user_id = \?/.test(social), 'individual blob fetch is owner and parent scoped');
check(/DELETE FROM activity_media[\s\S]*id = \? AND activity_id = \? AND activity_type = \? AND user_id = \?/.test(social), 'photo delete includes every ownership key');
check(/FOR UPDATE/.test(social) && /MAX_ACTIVITY_PHOTOS/.test(social), 'photo limit is serialized server-side');
check(/\(user_id = \? OR visibility = 'public'\)/.test(social), 'legacy singular GET only returns owner or public media');
check(/UPDATE activity_media SET data = \?, mime_type = \?[\s\S]*AND user_id = \?/.test(social), 'legacy photo update cannot transfer or cross owners');

console.log('\n== frontend and account-data wiring ==');
const manager = read('frontend/src/components/RunMediaManager.jsx');
const recap = read('frontend/src/pages/RunRecap.jsx');
const logRun = read('frontend/src/pages/LogRun.jsx');
const accountData = read('backend/src/lib/accountDataCoverage.js');
check(manager.includes('multiple') && !manager.includes('capture='), 'recap picker supports library multi-select without forcing the camera');
check(!manager.includes('alert('), 'gallery uses inline errors instead of browser alerts');
check(manager.includes("toDataURL('image/jpeg'") && manager.includes('MAX_DATA_LENGTH'), 'canvas conversion strips metadata and caps payload size');
check(recap.includes('<RunMediaManager runId={run.id} />'), 'run recap owns the gallery');
check(!logRun.includes('PhotoUploader'), 'manual run form no longer duplicates run-photo upload');
check(/activity_media'.*mime_type, created_at/.test(accountData) && !/activity_media'.*\bdata\b/.test(accountData), 'account export keeps media metadata but excludes base64 blobs');
check(accountData.includes('DELETE FROM activity_media WHERE user_id = ?'), 'account deletion still removes owned media');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('FRIENDS PHASE 2 SMOKE OK');
