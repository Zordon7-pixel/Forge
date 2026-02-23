export function formatDate(dateStr, lang = 'en') {
  try {
    return new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(dateStr))
  } catch {
    return dateStr
  }
}
