/**
 * vault.js — Secure file operations for Forge backend
 *
 * VAULT: [H2] hashFile symlink bypass fix
 * CVE class: Path traversal via symlink (CWE-61)
 *
 * Original bug (main.js:1671 pattern):
 *   path.resolve() does NOT follow symlinks. An attacker could create a
 *   symlink inside the allowed root pointing outside it, bypassing the
 *   boundary check and reading arbitrary files on the host.
 *
 * Fix: Use fs.realpathSync() BEFORE the boundary check so the canonical
 *   (resolved) path is used for comparison.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * hashFile(filePath, allowedRoot, algorithm = 'sha256')
 *
 * Computes a cryptographic hash of a file after verifying that its
 * canonical (realpath) path is within `allowedRoot`.
 *
 * @param {string} filePath     - Path to the file (may be relative or contain symlinks)
 * @param {string} allowedRoot  - Absolute directory the file must reside within
 * @param {string} algorithm    - Hash algorithm (default: 'sha256')
 * @returns {string}            - Hex digest of the file contents
 * @throws {Error}              - If file is outside allowedRoot, doesn't exist, or can't be read
 */
function hashFile(filePath, allowedRoot, algorithm = 'sha256') {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('[VAULT] hashFile: filePath must be a non-empty string');
  }
  if (!allowedRoot || typeof allowedRoot !== 'string') {
    throw new Error('[VAULT] hashFile: allowedRoot must be a non-empty string');
  }

  // Resolve allowedRoot to its canonical form (no trailing slash confusion)
  const canonicalRoot = fs.realpathSync(path.resolve(allowedRoot));

  // SECURITY FIX: Use fs.realpathSync() to resolve symlinks BEFORE boundary check.
  // path.resolve() alone does NOT follow symlinks, allowing bypass via symlink
  // inside the allowed root pointing outside it.
  let canonicalFile;
  try {
    canonicalFile = fs.realpathSync(path.resolve(filePath));
  } catch (err) {
    throw new Error(`[VAULT] hashFile: cannot resolve path "${filePath}": ${err.message}`);
  }

  // Boundary check on the canonical (symlink-resolved) paths
  // Ensure canonicalRoot ends with sep to prevent "/allowed-root-extra" bypass
  const rootWithSep = canonicalRoot.endsWith(path.sep)
    ? canonicalRoot
    : canonicalRoot + path.sep;

  if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(rootWithSep)) {
    throw new Error(
      `[VAULT] hashFile: path "${filePath}" resolves outside allowed root "${allowedRoot}"`
    );
  }

  // Compute the hash
  const fileBuffer = fs.readFileSync(canonicalFile);
  return crypto.createHash(algorithm).update(fileBuffer).digest('hex');
}

module.exports = { hashFile };
