const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function localISODate(now = new Date()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isISODate(value) {
  return typeof value === 'string' && ISO_DATE.test(value);
}

function dayDistance(left, right) {
  const leftDate = new Date(`${left}T12:00:00Z`);
  const rightDate = new Date(`${right}T12:00:00Z`);
  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) return null;
  return Math.round((leftDate.getTime() - rightDate.getTime()) / 86400000);
}

function requestPlanningDate(req, options = {}) {
  const now = options.now || new Date();
  const today = localISODate(now);
  const bodyKeys = options.bodyKeys || ['planning_date_local', 'date'];
  const queryKeys = options.queryKeys || ['date'];
  for (const key of bodyKeys) {
    const value = req?.body?.[key];
    if (isISODate(value)) return value;
  }
  for (const key of queryKeys) {
    const value = req?.query?.[key];
    if (isISODate(value)) return value;
  }
  const header = typeof req?.get === 'function'
    ? req.get('x-forged-local-date')
    : req?.headers?.['x-forged-local-date'];
  const distance = isISODate(header) ? dayDistance(header, today) : null;
  return distance !== null && Math.abs(distance) <= 1 ? header : today;
}

module.exports = {
  dayDistance,
  isISODate,
  localISODate,
  requestPlanningDate,
};
