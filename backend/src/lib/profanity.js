const Filter = require('bad-words')

const filter = new Filter()

function cleanText(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (!text.trim()) return ''
  return filter.clean(text)
}

module.exports = { cleanText }
