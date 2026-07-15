function betaAccessEnabled() {
  return String(process.env.FORGE_BETA_ACCESS || '').trim().toLowerCase() === 'true';
}

module.exports = { betaAccessEnabled };
