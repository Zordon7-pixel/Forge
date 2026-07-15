const { challengeTemplateLabel } = require('./challengeRules');

async function cleanupOwnedSocialChallenges(tx, userId) {
  const owned = await tx.all(
    `SELECT c.id, c.template_type
     FROM challenges c
     JOIN user_challenges owner_uc ON owner_uc.challenge_id = c.id
     WHERE c.kind = 'social'
       AND owner_uc.user_id = ?
       AND owner_uc.role = 'owner'
       AND owner_uc.status = 'joined'
     FOR UPDATE OF c, owner_uc`,
    [userId]
  );

  for (const challenge of owned) {
    const successor = await tx.get(
      `SELECT id, user_id
       FROM user_challenges
       WHERE challenge_id = ? AND user_id <> ?
         AND status = 'joined'
       ORDER BY joined_at ASC NULLS LAST, id ASC
       LIMIT 1
       FOR UPDATE`,
      [challenge.id, userId]
    );

    if (!successor) {
      const removedChallenge = await tx.run(
        `DELETE FROM challenges c
         WHERE c.id = ? AND c.kind = 'social'
           AND EXISTS (
             SELECT 1 FROM user_challenges owner_uc
             WHERE owner_uc.challenge_id = c.id
               AND owner_uc.user_id = ?
               AND owner_uc.role = 'owner'
               AND owner_uc.status = 'joined'
           )`,
        [challenge.id, userId]
      );
      if (removedChallenge.changes !== 1) throw new Error('Challenge owner cleanup lost its ownership guard');
      await tx.run(
        `DELETE FROM user_challenges target_uc
         WHERE target_uc.challenge_id = ?
           AND EXISTS (
             SELECT 1 FROM user_challenges owner_uc
             WHERE owner_uc.challenge_id = target_uc.challenge_id
               AND owner_uc.user_id = ?
               AND owner_uc.role = 'owner'
           )`,
        [challenge.id, userId]
      );
      continue;
    }

    const anonymized = await tx.run(
      `UPDATE challenges c
       SET creator_id = NULL, name = ?, description = NULL
       WHERE c.id = ? AND c.kind = 'social'
         AND EXISTS (
           SELECT 1 FROM user_challenges owner_uc
           WHERE owner_uc.challenge_id = c.id
             AND owner_uc.user_id = ?
             AND owner_uc.role = 'owner'
             AND owner_uc.status = 'joined'
         )`,
      [challengeTemplateLabel(challenge.template_type), challenge.id, userId]
    );
    if (anonymized.changes !== 1) throw new Error('Challenge anonymization lost its ownership guard');

    const promoted = await tx.run(
      `UPDATE user_challenges promoted_uc
       SET role = 'owner', updated_at = NOW()
       WHERE promoted_uc.id = ?
         AND promoted_uc.user_id = ?
         AND promoted_uc.challenge_id = ?
         AND promoted_uc.status = 'joined'
         AND EXISTS (
           SELECT 1 FROM user_challenges owner_uc
           WHERE owner_uc.challenge_id = promoted_uc.challenge_id
             AND owner_uc.user_id = ?
             AND owner_uc.role = 'owner'
             AND owner_uc.status = 'joined'
         )`,
      [successor.id, successor.user_id, challenge.id, userId]
    );
    if (promoted.changes !== 1) throw new Error('Challenge owner promotion lost its membership guard');

    const removedOwner = await tx.run(
      `DELETE FROM user_challenges
       WHERE challenge_id = ? AND user_id = ?
         AND role = 'owner' AND status = 'joined'`,
      [challenge.id, userId]
    );
    if (removedOwner.changes !== 1) throw new Error('Challenge owner membership cleanup failed');
  }
}

module.exports = { cleanupOwnedSocialChallenges };
