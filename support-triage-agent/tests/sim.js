// Minimal n8n graph simulator: executes the generated workflow JSON (Code, IF, Switch, Respond, HTTP stubs)
// so routing, Code-node logic, and node connections can be tested without an n8n instance.
// It does NOT emulate n8n itself (credentials, retries, binary storage, real expression engine).

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function createSim(workflow, { env = {}, http = {}, startMs = Date.parse('2026-11-19T12:00:00Z') } = {}) {
  const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
  const sim = { nowMs: startMs, staticData: {}, calls: [], http };

  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(sim.nowMs); }
    static now() { return sim.nowMs; }
  }

  async function run(entry, firstItem) {
    const outputs = {};
    const responses = [];
    const trace = [];
    const $ = (name) => ({
      first() { const o = outputs[name]; if (!o || !o.length) throw new Error('Node "' + name + '" has not run'); return o[0]; },
      all() { return outputs[name] || []; },
    });
    const evalExpr = (v, item) => {
      if (typeof v !== 'string' || !v.startsWith('={{') || !v.endsWith('}}')) return v;
      return new Function('$json', '$', 'return (' + v.slice(3, -2) + ')')(item.json, $);
    };
    const condTrue = (c, item) => {
      const left = evalExpr(c.leftValue, item);
      const { type, operation } = c.operator;
      if (type === 'boolean') return operation === 'true' ? left === true : left === false;
      if (type === 'string' && operation === 'equals') return left === c.rightValue;
      throw new Error('unsupported condition ' + type + '/' + operation);
    };

    async function exec(node, items) {
      switch (node.type) {
        case 'n8n-nodes-base.webhook':
        case 'n8n-nodes-base.scheduleTrigger':
          return [items];
        case 'n8n-nodes-base.code': {
          const item = items[0];
          const fn = new AsyncFunction('$input', '$', '$getWorkflowStaticData', '$env', '$vars', 'Date', node.parameters.jsCode);
          const helpers = { getBinaryDataBuffer: async (_i, prop) => { const b = item.binary && item.binary[prop]; if (!b) throw new Error('no binary'); return b.buf; } };
          const res = await fn.call({ helpers }, { first: () => item, all: () => items }, $, () => sim.staticData, env, {}, FakeDate);
          return [res];
        }
        case 'n8n-nodes-base.if': {
          const t = [], f = [];
          for (const it of items) (node.parameters.conditions.conditions.every((c) => condTrue(c, it)) ? t : f).push(it);
          return [t, f];
        }
        case 'n8n-nodes-base.switch': {
          const rules = node.parameters.rules.values;
          const outs = rules.map(() => []);
          for (const it of items) {
            const i = rules.findIndex((r) => r.conditions.conditions.every((c) => condTrue(c, it)));
            if (i >= 0) outs[i].push(it);
          }
          return outs;
        }
        case 'n8n-nodes-base.respondToWebhook': {
          const it = items[0];
          const code = evalExpr(node.parameters.options.responseCode, it);
          responses.push({ node: node.name, code: Number(code), body: evalExpr(node.parameters.responseBody, it) });
          return [items];
        }
        case 'n8n-nodes-base.httpRequest': {
          const stub = http[node.name];
          if (!stub) throw new Error('No HTTP stub for "' + node.name + '"');
          const it = items[0];
          const body = JSON.parse(evalExpr(node.parameters.jsonBody, it));
          sim.calls.push({ node: node.name, body });
          try {
            const r = await stub(body, sim);
            return node.onError === 'continueErrorOutput' ? [[{ json: r || {} }], []] : [[{ json: r || {} }]];
          } catch (e) {
            if (node.onError === 'continueErrorOutput') return [[], [{ json: { error: { message: e.message } } }]];
            if (node.onError === 'continueRegularOutput') return [[{ json: { error: { message: e.message } } }]];
            throw e;
          }
        }
        default:
          throw new Error('unsupported node type ' + node.type);
      }
    }

    const queue = [{ name: entry, items: [firstItem] }];
    let guard = 0;
    while (queue.length) {
      if (++guard > 200) throw new Error('graph loop?');
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
