const { nextRun } = require('./cron');
const audit = require('./audit');

// For each scheduled task, finds the newest slot that is due and enqueues it. A unique index on
// (task, slot) makes this exactly-once even with several schedulers running, and a long outage
// produces one catch-up run, not a flood.
async function tick(pool, agent, now = new Date()) {
  const { rows: tasks } = await pool.query('SELECT id, name, schedule, created_at FROM tasks WHERE enabled AND schedule IS NOT NULL');
  const enqueued = [];
  for (const t of tasks) {
    const last = (await pool.query('SELECT MAX(scheduled_for) AS m FROM runs WHERE task_id = $1', [t.id])).rows[0].m;
    let slot = nextRun(t.schedule, last ? new Date(last) : new Date(t.created_at));
    let due = null, missed = 0;
    for (let i = 0; i < 2000 && slot <= now; i++) { if (due) missed++; due = slot; slot = nextRun(t.schedule, slot); }
    if (!due) continue;
    const id = await agent.enqueue(t.name, 'schedule', due);
    if (id) {
      enqueued.push(id);
      if (missed) await audit.append(pool, { actor: 'scheduler', event: 'scheduler.skipped_missed', runId: id, detail: { task: t.name, skipped: missed } });
    }
  }
  return enqueued;
}

module.exports = { tick };
