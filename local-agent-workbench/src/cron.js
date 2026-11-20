// Five-field cron (minute hour day-of-month month day-of-week) in local time.
// Supports *, lists, ranges, and steps. Day-of-week 0-6 (7 also means Sunday).

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(text, [min, max], isDow) {
  const out = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error('bad cron field "' + text + '"');
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error('bad cron step');
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number); }
    else { lo = Number(m[1]); hi = m[2] ? max : lo; }
    if (lo < min || hi > max || lo > hi) throw new Error('cron value out of range in "' + text + '"');
    for (let v = lo; v <= hi; v += step) out.add(isDow && v === 7 ? 0 : v);
  }
  return out;
}

function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields');
  const sets = f.map((x, i) => parseField(x, RANGES[i], i === 4));
  return { min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow: sets[4], domStar: f[2] === '*', dowStar: f[4] === '*' };
}

function matches(c, d) {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
  // Standard cron: if both day fields are restricted, either may match.
  return c.domStar || c.dowStar ? domOk && dowOk : domOk || dowOk;
}

// First matching minute strictly after `after`.
function nextRun(expr, after) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error('cron never matches');
}

module.exports = { parseCron, nextRun };
