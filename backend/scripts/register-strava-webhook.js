'use strict';
// Deliberately fail closed until operator registration uses the same deployed
// provider-wide reservation authority. Never fall back to standalone fetch.
console.error('STRAVA_REGISTRATION_UNAVAILABLE: shared provider reservation is required; no provider request was sent.');
process.exitCode = 1;
