// Minimal n8n graph simulator for the reconciliation workflow: runs the generated workflow JSON
// (Code, IF, Respond, multi-item HTTP stubs) with a fake clock and persistent static data.
// It is NOT n8n: no expression engine, credentials, pagination engine or batching.

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function createSim(workflow, { http = {}, startMs = Date.parse('2026-11-19T12:00:00Z') } = {}) {
  const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
  const sim = { nowMs: startMs, staticData: {}, calls: [], http };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(sim.nowMs); }
    static now() { return sim.nowMs; }
  }

  async function run(entry, firstItem) {
    const outputs = {}; const responses = []; const trace = [];
    const $ = (name) => ({
      first() { const o = outputs[name]; if (!o || !o.length) throw new Error('Node "' + name + '" has not run'); return o[0]; },
      all() { const o = outputs[name]; if (!o) throw new Error('Node "' + name + '" has not run'); return o; },
    });
    const evalExpr = (v, item) => {
      if (typeof v !== 'string' || !v.startsWith('={{') || !v.endsWith('}}')) return v;
      return new Function('$json', '$', 'return (' + v.slice(3, -2) + ')')(item.json, $);
    };
    const condTrue = (c, item) => {
      const left = evalExpr(c.leftValue, item);
      if (c.operator.type === 'boolean') return c.operator.operation === 'true' ? left === true : left === false;
      throw new Error('unsupported condition');
    };
    async function exec(node, items) {
      switch (node.type) {
        case 'n8n-nodes-base.webhook': case 'n8n-nodes-base.scheduleTrigger': return [items];
        case 'n8n-nodes-base.code': {
          const fn = new AsyncFunction('$input', '$', '$getWorkflowStaticData', 'Date', node.parameters.jsCode);
          const res = await fn.call({}, { first: () => items[0], all: () => items }, $, () => sim.staticData, FakeDate);
          return [res];
        }
        case 'n8n-nodes-base.if': {
          const t = [], f = [];
          for (const it of items) (node.parameters.conditions.conditions.every((c) => condTrue(c, it)) ? t : f).push(it);
          return [t, f];
        }
        case 'n8n-nodes-base.respondToWebhook': {
          const it = items[0];
          responses.push({ node: node.name, code: Number(evalExpr(node.parameters.options.responseCode, it)), body: evalExpr(node.parameters.responseBody, it) });
          return [items];
        }
        case 'n8n-nodes-base.httpRequest': {
          const stub = http[node.name];
          if (!stub) throw new Error('No HTTP stub for "' + node.name + '"');
          const ok = [], errs = [];
          for (const it of items) {
            const p = node.parameters;
            const body = p.jsonBody ? JSON.parse(evalExpr(p.jsonBody, it)) : null;
            const headers = Object.fromEntries(((p.headerParameters || {}).parameters || []).map((h) => [h.name, evalExpr(h.value, it)]));
            const req = { node: node.name, method: evalExpr(p.method, it), url: evalExpr(p.url, it), headers, body };
            sim.calls.push(req);
            try {
              const r = await stub(req, sim);
              (Array.isArray(r) ? r : [r || {}]).forEach((x) => ok.push({ json: x }));
            } catch (e) {
              const errItem = { json: { error: { message: e.message } } };
              if (node.onError === 'continueErrorOutput') errs.push(errItem);
              else if (node.onError === 'continueRegularOutput') ok.push(errItem);
              else throw e;
            }
          }
          return node.onError === 'continueErrorOutput' ? [ok, errs] : [ok];
        }
        default: throw new Error('unsupported node type ' + node.type);
      }
    }
    const queue = [{ name: entry, items: [firstItem] }];
    let guard = 0;
    while (queue.length) {
      if (++guard > 300) throw new Error('graph loop?');
      const { name, items } = queue.shift();
      trace.push(name);
      const outs = await exec(byName[name], items);
      outputs[name] = outs.flat();
      const conns = (workflow.connections[name] || { main: [] }).main;
      outs.forEach((o, i) => { if (o && o.length) for (const l of conns[i] || []) queue.push({ name: l.node, items: o }); });
    }
    return { responses, trace };
  }
  sim.run = run;
  return sim;
}
module.exports = { createSim };
