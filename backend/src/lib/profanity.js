const Filter = require('bad-words')

const filter = new Filter()

function cleanText(value) {
  if (value === null || value === undefined) return ''
  return filter.clean(String(value))
}

module.exports = { cleanText }
