import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Harness-owned service, never a controller-managed daemon. Project-command
// listeners are separately owned and closed inside scheduling-command.mjs.
export async function schedulingHarness(scenario) {
  let sequence = 0; let failure; let tickets = {}; let owner;
  const events = []; const pairs = []; const leases = []; const conflicts = [];
  const waitingPair = []; const deliveries = new Set(); const deliveryWaiters = new Map();
  const submitted = new Set(); const pendingCandidates = []; let reviewWhileHeld = false;
  const respond = (res, value = { ok: true }) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 64_000); }
      const value = JSON.parse(body || '{}'); const current = ++sequence;
      if (req.url === '/event') {
        events.push({ ...value, sequence: current });
        if (value.type === 'notice') {
          const delivered = /^TICKET_DELIVERED: #(\d+) /.exec(value.message);
          if (delivered) { const ticket = Number(delivered[1]); deliveries.add(ticket); deliveryWaiters.get(ticket)?.forEach(resolve => resolve()); }
          if (value.message.startsWith('FLOW_TICKET_STATE: ')) {
            const state = JSON.parse(value.message.slice('FLOW_TICKET_STATE: '.length));
            if (state.state === 'submitted') submitted.add(state.ticket);
            if (submitted.has(tickets.A?.number) && submitted.has(tickets.B?.number)) pendingCandidates.splice(0).forEach(response => respond(response));
          }
          if (value.message.startsWith('FLOW_ACTIVITY: ')) {
            const activity = JSON.parse(value.message.slice('FLOW_ACTIVITY: '.length));
            if (activity.kind === 'review' && activity.event === 'start' && owner?.ticket === activity.ticket) reviewWhileHeld = true;
          }
        }
        respond(res);
      } else if (req.url === '/pair') {
        assert.ok([tickets.A.number, tickets.B.number].includes(value.ticket));
        assert.match(value.value, /^ticket-\d+$/); assert.equal(value.key, 'shared-logical-key');
        waitingPair.push({ ...value, response: res });
        if (waitingPair.length === 2) {
          const pair = await Promise.all(waitingPair.map(async entry => {
            const remote = await fetch(`http://127.0.0.1:${entry.port}/shared-logical-key`);
            assert.equal(remote.status, 200); const item = await remote.json();
            assert.deepEqual(item, { key: entry.key, value: entry.value });
            return { ticket: entry.ticket, port: entry.port, key: entry.key, value: entry.value, received: item.value };
          }));
          assert.notEqual(pair[0].port, pair[1].port); pairs.push(pair);
          waitingPair.splice(0).forEach(entry => respond(entry.response));
        }
      } else if (req.url === '/acquire') {
        if (owner) { conflicts.push({ previous: owner.ticket, next: value.ticket }); throw new Error('Shared namespace overlap'); }
        owner = { ticket: value.ticket, phase: value.phase, acquired: current }; leases.push(owner); respond(res);
      } else if (req.url === '/release') {
        assert.equal(owner?.ticket, value.ticket); assert.equal(owner?.phase, value.phase);
        owner.released = current; owner = undefined; respond(res);
      } else if (req.url === '/before-candidate') {
        if (scenario !== 'slot-release-and-local-block' || (submitted.has(tickets.A.number) && submitted.has(tickets.B.number))) respond(res);
        else pendingCandidates.push(res);
      } else { res.writeHead(404); res.end(); }
    } catch (error) { failure = error; res.writeHead(500); res.end('Synthetic harness protocol violation'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, setup(value) { tickets = value; }, sequence: () => ++sequence,
    waitDelivery(ticket) { if (deliveries.has(ticket)) return Promise.resolve(); return new Promise(resolve => { const waits = deliveryWaiters.get(ticket) ?? []; waits.push(resolve); deliveryWaiters.set(ticket, waits); }); },
    snapshot() { if (failure) throw failure; return { events, resources: { isolatedPairs: pairs, leases, conflicts, reviewWhileHeld } }; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
