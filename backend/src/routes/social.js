const router = require('express').Router()
const { v4: uuidv4 } = require('uuid')
const db = require('../db')
const auth = require('../middleware/auth')
const { cleanText } = require('../lib/profanity')

router.post('/like', auth, (req, res) => {
  const { activity_id, activity_type } = req.body || {}
  if (!activity_id || !activity_type) {
    return res.status(400).json({ error: 'activity_id and activity_type are required' })
  }

  const existing = db.prepare(
    'SELECT id FROM activity_likes WHERE activity_id = ? AND activity_type = ? AND user_id = ?'
  ).get(activity_id, activity_type, req.user.id)

  let liked = false
  if (existing) {
    db.prepare('DELETE FROM activity_likes WHERE id = ?').run(existing.id)
  } else {
    db.prepare('INSERT INTO activity_likes (id, activity_id, activity_type, user_id) VALUES (?,?,?,?)')
      .run(uuidv4(), activity_id, activity_type, req.user.id)
    liked = true
  }

  const count = db.prepare(
    'SELECT COUNT(*) as cnt FROM activity_likes WHERE activity_id = ? AND activity_type = ?'
  ).get(activity_id, activity_type)

  res.json({ liked, count: count?.cnt || 0 })
})

router.get('/:activity_type/:activity_id/comments', auth, (req, res) => {
  const { activity_id, activity_type } = req.params
  const comments = db.prepare(`
    SELECT c.id, c.user_id, u.name as user_name, c.content, c.created_at
    FROM activity_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.activity_id = ? AND c.activity_type = ?
    ORDER BY c.created_at ASC
  `).all(activity_id, activity_type)

  res.json({ comments })
})

router.post('/:activity_type/:activity_id/comments', auth, (req, res) => {
  const { activity_id, activity_type } = req.params
  const content = String(req.body?.content || '').trim()
  const cleanedContent = cleanText(content)

  if (!cleanedContent) return res.status(400).json({ error: 'Comment is required' })
  if (cleanedContent.length > 280) return res.status(400).json({ error: 'Comment must be 280 characters or less' })

  const id = uuidv4()
  db.prepare(
    'INSERT INTO activity_comments (id, activity_id, activity_type, user_id, content) VALUES (?,?,?,?,?)'
  ).run(id, activity_id, activity_type, req.user.id, cleanedContent)

  const comment = db.prepare(`
    SELECT c.id, c.user_id, u.name as user_name, c.content, c.created_at
    FROM activity_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(id)

  res.status(201).json({ comment })
})

router.post('/:activity_type/:activity_id/photo', auth, (req, res) => {
  const { activity_id, activity_type } = req.params
  const data = String(req.body?.data || '')
  const mimeType = String(req.body?.mime_type || 'image/jpeg')

  if (!data) return res.status(400).json({ error: 'Photo data is required' })
  if (data.length > 1000000) return res.status(400).json({ error: 'Photo too large — must be under 1MB' })
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return res.status(400).json({ error: 'Invalid image type' })

  try {
    const existing = db.prepare(
      'SELECT id FROM activity_media WHERE activity_id = ? AND activity_type = ? LIMIT 1'
    ).get(activity_id, activity_type)

    let mediaId = existing?.id
    if (existing) {
      db.prepare('UPDATE activity_media SET data = ?, mime_type = ?, user_id = ?, created_at = datetime(\'now\') WHERE id = ?')
        .run(data, mimeType, req.user.id, existing.id)
    } else {
      mediaId = uuidv4()
      db.prepare(
        'INSERT INTO activity_media (id, activity_id, activity_type, user_id, data, mime_type) VALUES (?,?,?,?,?,?)'
      ).run(mediaId, activity_id, activity_type, req.user.id, data, mimeType)
    }

    const media = db.prepare('SELECT id, data, mime_type FROM activity_media WHERE id = ?').get(mediaId)
    res.json({ media })
  } catch (err) {
    console.error('Photo upload error:', err)
    res.status(500).json({ error: 'Failed to save photo' })
  }
})

router.get('/:activity_type/:activity_id/photo', auth, (req, res) => {
  const { activity_id, activity_type } = req.params
  const media = db.prepare(
    'SELECT id, data, mime_type FROM activity_media WHERE activity_id = ? AND activity_type = ? LIMIT 1'
  ).get(activity_id, activity_type)

  res.json({ media: media || null })
})

module.exports = router
