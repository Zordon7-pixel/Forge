function monthBounds(monthKey) {
  const key = String(monthKey || '');
  const match = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.exec(String(key));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endExclusive = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  const label = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  return { key, start, endExclusive, label };
}

function roundMiles(value) {
  const miles = Number(value);
  if (!Number.isFinite(miles) || miles < 0) return 0;
  return Math.round((miles + Number.EPSILON) * 100) / 100;
}

function rankFriendMileage(rows, viewerId) {
  const normalized = (rows || []).map((row) => ({
    userId: String(row.user_id),
    name: String(row.name || 'Athlete'),
    handle: row.friend_handle ? String(row.friend_handle) : null,
    miles: roundMiles(row.miles),
    runCount: Math.max(0, Number(row.run_count) || 0),
  })).sort((left, right) => (
    right.miles - left.miles
    || left.name.localeCompare(right.name)
    || left.userId.localeCompare(right.userId)
  ));

  let previousMiles = null;
  let rank = 0;
  return normalized.map((row, index) => {
    if (previousMiles === null || row.miles !== previousMiles) rank = index + 1;
    previousMiles = row.miles;
    return {
      rank,
      is_self: row.userId === String(viewerId),
      user: { name: row.name, handle: row.handle },
      miles: row.miles,
      run_count: row.runCount,
    };
  });
}

module.exports = { monthBounds, rankFriendMileage };
