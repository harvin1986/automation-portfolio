// A stateful fake CRM + billing system. PATCH calls really mutate the data, so a second
// reconciliation run sees the effect of the first one.
const fs = require('fs');
const path = require('path');
const { createSim } = require('./sim');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'customer-reconciliation-engine.json'), 'utf8'));

function seed() {
  const crm = [
    { id: 'c1', full_name: 'Alice Johnson', email: 'alice@acme.com', phone: '(410) 555-0101', postal_code: '21061', billing_id: 'b1', plan: 'free', status: 'active' },
    { id: 'c2', full_name: 'Bob  Smith', email: 'bob+news@gmail.com', phone: '410-555-0102', postal_code: '21201', billing_id: null, plan: 'pro', status: 'active' },
    { id: 'c3', full_name: 'Carla Gomez-Diaz', email: 'carla.new@x.org', phone: '4105550103', postal_code: '21044', billing_id: 'b3', plan: 'pro', status: 'active' },
    { id: 'c4', full_name: 'Katherine Lee', email: 'klee@x.com', phone: '410-555-0104', postal_code: '21046', billing_id: null, plan: 'free', status: 'active' },
    { id: 'c5', full_name: 'Zed Nobody', email: 'zed@nowhere.com', phone: '410-555-0105', postal_code: '21000', billing_id: null, plan: 'free', status: 'active' },
    { id: 'c6', full_name: 'Shared One', email: 'shared@team.com', phone: '410-555-0106', postal_code: '21002', billing_id: null, plan: 'free', status: 'active' },
    { id: 'c7', full_name: 'Shared Two', email: 'shared@team.com', phone: '410-555-0107', postal_code: '21003', billing_id: null, plan: 'free', status: 'active' },
    { id: 'c8', full_name: 'Hannah Blank', email: 'hannah@h.com', phone: '', postal_code: '21008', billing_id: 'b8', plan: 'pro', status: 'active' },
    { id: 'c10', full_name: 'Jon Smith', email: 'jsmith@work.io', phone: '410-555-0110', postal_code: '21046', billing_id: null, plan: 'free', status: 'active' },
  ];
  const billing = [
    { id: 'b1', name: 'Alice Johnson', email: 'alice@acme.com', phone: '410-555-0101', postal: '21061', plan: 'pro', status: 'active' },
    { id: 'b2', name: 'Bob Smith', email: 'bob@gmail.com', phone: '410-555-0102', postal: '21201', plan: 'pro', status: 'active' },
    { id: 'b3', name: 'Carla Gomez Diaz', email: 'carla@x.org', phone: '4105550103', postal: '21044', plan: 'pro', status: 'active' },
    { id: 'b4', name: 'Catherine Lee', email: 'klee@y.com', phone: '410-555-0104', postal: '21401', plan: 'free', status: 'active' },
    { id: 'b6', name: 'Team Account', email: 'shared@team.com', phone: '410-555-0199', postal: '21099', plan: 'free', status: 'active' },
    { id: 'b8', name: 'Hannah Blank', email: 'hannah@h.com', phone: '410-555-0108', postal: '21008', plan: 'pro', status: 'active' },
    { id: 'b9', name: 'Orphan Corp', email: 'orphan@corp.com', phone: '410-555-0109', postal: '21009', plan: 'pro', status: 'active' },
    { id: 'b10', name: 'Jonathan Smith', email: 'jsmith@home.net', phone: '410-555-0199', postal: '21046', plan: 'free', status: 'active' },
  ];
  return { crm, billing };
}

const pages = (rows, size = 3) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push({ data: rows.slice(i, i + size), next_cursor: i + size < rows.length ? 'cur' + (i + size) : null });
  return out.length ? out : [{ data: [], next_cursor: null }];
};

// Default model behavior: says "same entity" with high confidence for every pair it is shown.
function yesToAll(req) {
  const pairs = JSON.parse(/<pairs>\n([\s\S]*)\n<\/pairs>/.exec(req.body.messages[0].content)[1]);
  return { usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'tool_use', name: 'record_decisions', input: { decisions: pairs.map((p) => ({ pair_id: p.pair_id, same_entity: true, confidence: 0.99 })) } }] };
}

function makeWorld(overrides = {}) {
  const { crm, billing } = seed();
  const world = { crm, billing, patches: [], reports: [], failIds: new Set(), claude: yesToAll, claudeCalls: [], ...overrides };
  const idOf = (url) => decodeURIComponent(url.split('/').pop());
  const patcher = (rows, target) => async (req) => {
    const id = idOf(req.url);
    if (world.failIds.has(id)) throw new Error('503 service unavailable');
    const rec = rows().find((r) => r.id === id);
    if (!rec) throw new Error('404');
    Object.assign(rec, req.body);
    world.patches.push({ target, id, body: req.body, key: req.headers['Idempotency-Key'] });
    return { ok: true };
  };
  const http = {
    'Fetch CRM': async () => { if (world.failFetch) throw new Error('CRM 500'); return pages(world.crm); },
    'Fetch Billing': async () => pages(world.billing),
    'Apply to Billing': patcher(() => world.billing, 'billing'),
    'Apply to CRM': patcher(() => world.crm, 'crm'),
    'Claude Adjudicate': async (req) => { world.claudeCalls.push(req.body); return world.claude(req); },
    'Post Report': async (req) => { world.reports.push(req.body.text); return {}; },
    'Post Alert': async (req) => { world.reports.push(req.body.text); return {}; },
  };
  world.sim = createSim(wf, { http });
  world.run = (body = {}) => world.sim.run('Manual Run Webhook', { json: { body } });
  world.sd = world.sim.staticData;
  return world;
}

module.exports = { makeWorld, wf, yesToAll };
