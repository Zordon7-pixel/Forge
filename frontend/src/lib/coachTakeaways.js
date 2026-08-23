const TAKEAWAY_PRIORITIES = Object.freeze({
  Pain: 0,
  Safety: 0,
  'Next Step': 1,
  Recovery: 2,
  Effort: 3,
})

const EXPLICIT_LABELS = Object.freeze({
  effort: 'Effort',
  pain: 'Pain',
  recovery: 'Recovery',
  safety: 'Safety',
  next: 'Next Step',
  'next step': 'Next Step',
  'next session': 'Next Step',
})

function cleanSegment(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitSentences(value) {
  const sentences = []
  let start = 0

  for (let index = 0; index < value.length; index += 1) {
    if (!'.!?'.includes(value[index])) continue

    let end = index + 1
    while (end < value.length && /[\"')\]}]/.test(value[end])) end += 1
    if (end < value.length && !/\s/.test(value[end])) continue

    const sentence = cleanSegment(value.slice(start, end))
    if (sentence) sentences.push(sentence)
    while (end < value.length && /\s/.test(value[end])) end += 1
    start = end
    index = end - 1
  }

  const remainder = cleanSegment(value.slice(start))
  if (remainder) sentences.push(remainder)
  return sentences
}

function splitSingleSentence(value) {
  return value
    .split(/\s*;\s+|\s+[—–]\s+|,\s+(?=(?:and|but|so|then|while)\b)/i)
    .map(cleanSegment)
    .filter(Boolean)
}

function mergeToTakeawayLimit(segments, limit = 4) {
  const merged = [...segments]
  while (merged.length > limit) {
    let mergeAt = 0
    let shortestPair = Number.POSITIVE_INFINITY
    for (let index = 0; index < merged.length - 1; index += 1) {
      const pairLength = merged[index].length + merged[index + 1].length
      if (pairLength < shortestPair) {
        mergeAt = index
        shortestPair = pairLength
      }
    }
    merged.splice(mergeAt, 2, `${merged[mergeAt]} ${merged[mergeAt + 1]}`)
  }
  return merged
}

function categoryFor(text) {
  if (/\b(?:pain|painful|injur(?:y|ed)|hurt|ache|sore|soreness|niggle|discomfort)\b/i.test(text)) return 'Pain'
  if (/\b(?:medical|doctor|physician|clinician|professional assessment|seek care|symptom|chest pain|dizz(?:y|iness)|faint(?:ing)?|unsafe|safety|risk)\b/i.test(text)) return 'Safety'
  if (/\b(?:recover(?:y|ed|ing)?|rest|fatigue|fatigued|tired|sleep|energy|cns|hydration|hydrate|easy day|load management)\b/i.test(text)) return 'Recovery'
  if (/\b(?:next|aim|target|focus|keep|try|consider|should|plan|add|reduce|increase|hold|prioriti[sz]e|monitor|avoid|take|use|back off|ease|build|progress|adjust|maintain|schedule|repeat|stay)\b/i.test(text)) return 'Next Step'
  return 'Effort'
}

function takeawayFromSegment(text, index) {
  const explicit = text.match(/^(effort|pain|recovery|safety|next(?: step| session)?)\s*:\s*/i)
  const explicitLabel = explicit ? EXPLICIT_LABELS[explicit[1].toLowerCase()] : null
  const supportingCopy = cleanSegment(explicit ? text.slice(explicit[0].length) : text)
  if (!supportingCopy) return null

  const label = explicitLabel || categoryFor(supportingCopy)
  return {
    label,
    text: supportingCopy,
    priority: TAKEAWAY_PRIORITIES[label],
    index,
  }
}

export function buildCoachTakeaways(feedback) {
  if (typeof feedback !== 'string' || !feedback.trim()) return []

  let segments = feedback
    .split(/[\r\n]+/)
    .flatMap((line) => splitSentences(cleanSegment(line)))
    .filter(Boolean)

  if (segments.length === 1) {
    const clauses = splitSingleSentence(segments[0])
    if (clauses.length > 1) segments = clauses
  }

  return mergeToTakeawayLimit(segments)
    .map(takeawayFromSegment)
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ label, text }) => ({ label, text }))
}
