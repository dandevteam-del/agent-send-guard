/**
 * Run: node examples/quickstart.mjs
 *
 * Reproduces incident #1 against a 14-record dataset owned by one human, and shows the
 * difference between the per-record filter that caused it and the per-address guard.
 */
import { addressIndex, screen, groupByAddress } from '../src/index.js';

const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();

// One person runs fourteen festivals. Fourteen records, one inbox.
const records = Array.from({ length: 14 }, (_, i) => ({
  id: `festival-${i + 1}`,
  name: `County Fair ${i + 1}`,
  contact_email: 'onebusyorganizer@example.org',
  state_machine: 'NEW',
  history: [],
}));

// Plus one unrelated venue that has already told us no.
records.push({
  id: 'venue-x', name: 'Venue X', contact_email: 'gate@example.org',
  state_machine: 'REJECTED', history: [],
});
// ...which also owns a second record still sitting at NEW.
records.push({
  id: 'venue-x-summer', name: 'Venue X Summer Series',
  contact_email: 'gate@example.org', state_machine: 'NEW', history: [],
});

console.log('\n── THE BUG ─────────────────────────────────────────────────────');
const naive = records.filter((r) => r.contact_email && r.state_machine === 'NEW');
console.log(`per-record filter approves ${naive.length} sends`);
console.log(`...to ${new Set(naive.map((r) => r.contact_email)).size} actual humans.`);

console.log('\n── WITH THE GUARD, nothing sent yet ────────────────────────────');
let ix = addressIndex(records);
let { allowed, blocked } = screen(records.filter((r) => r.state_machine === 'NEW'), ix);
console.log(`allowed ${allowed.length}, blocked ${blocked.length}`);
for (const b of blocked) console.log(`  blocked ${b.record.id}: ${b.reason}`);
console.log('\ngrouped into one message per human:');
for (const g of groupByAddress(allowed.map((a) => a.record))) {
  console.log(`  → ${g.address}  (${g.records.length} record${g.records.length > 1 ? 's' : ''} named in one email)`);
}

console.log('\n── AFTER TWO SENDS LAND ────────────────────────────────────────');
records[0].history = [{ state: 'EMAILED', at: ago(30), to: 'onebusyorganizer@example.org' }];
records[1].history = [{ state: 'EMAILED', at: ago(20), to: 'onebusyorganizer@example.org' }];
ix = addressIndex(records);
({ allowed, blocked } = screen(records.filter((r) => r.state_machine === 'NEW'), ix));
console.log(`allowed ${allowed.length}, blocked ${blocked.length}`);
console.log(`  ${blocked[0].record.id}: ${blocked[0].reason}`);
console.log('\nThe 14 records that caused incident #1 now produce 0 further sends.\n');
