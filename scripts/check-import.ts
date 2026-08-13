/**
 * Allowlist parser checks for `.tinysystem.json` imports.
 *
 *   npx tsx scripts/check-import.ts
 */
import { parseSystemExport } from '../src/store/parseExport';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

function throws(name: string, json: string, match?: string): void {
  try {
    parseSystemExport(json);
    check(name, false, 'expected throw');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, match ? msg.includes(match) : true, match ? `got: ${msg}` : '');
  }
}

const valid = {
  formatVersion: 4,
  app: 'hex-world-builder',
  kind: 'system',
  system: {
    name: 'Sol',
    seed: 'abc',
    genVersion: 13,
    createdAt: 1,
    updatedAt: 2,
    cam: { mode: 'orbit', bodyId: 'p3', q: [0, 0, 0, 1], d: 12, style: 'geo' },
  },
  bodyState: [{ bodyId: 'p3', name: 'Home', temp: 0.5, seaLevel: 0.5 }],
  terrain: [{ bodyId: 'p3', packed: [0, 12, 1, 8] }],
  labels: [{ bodyId: 'p3', cell: 4, text: 'Bay' }],
  objects: [{ bodyId: 'p3', cell: 5, kind: 'town', name: 'Port' }],
};

const parsed = parseSystemExport(JSON.stringify(valid));
check('valid export parses', parsed.system.name === 'Sol' && parsed.labels[0].text === 'Bay');
check('drops unknown system keys', !('extra' in parsed.system) && !('id' in parsed.system));

throws('wrong app', JSON.stringify({ ...valid, app: 'other' }), 'recognizable');
throws('old format', JSON.stringify({ ...valid, formatVersion: 3 }), 'recognizable');
throws('not json', '<<<', 'recognizable');
throws('proto key', '{"__proto__":{"x":1},"app":"hex-world-builder"}', 'recognizable');
throws('huge name', JSON.stringify({ ...valid, system: { ...valid.system, name: 'a'.repeat(201) } }), 'too long');
throws('bad body id', JSON.stringify({ ...valid, bodyState: [{ bodyId: 'sun' }] }), 'body id');
throws('duplicate body', JSON.stringify({ ...valid, bodyState: [{ bodyId: 'p3' }, { bodyId: 'p3' }] }), 'Duplicate');
throws('bad object kind', JSON.stringify({ ...valid, objects: [{ bodyId: 'p3', cell: 1, kind: 'castle', name: 'X' }] }), 'object');
throws('odd packed', JSON.stringify({ ...valid, terrain: [{ bodyId: 'p3', packed: [1] }] }), 'terrain');
throws('level out of range', JSON.stringify({ ...valid, terrain: [{ bodyId: 'p3', packed: [0, 99] }] }), 'terrain');
throws('script in camera mode', JSON.stringify({
  ...valid,
  system: { ...valid.system, cam: { mode: 'orbit', bodyId: 'p3<script>', q: [0, 0, 0, 1], d: 1 } },
}), 'body id');

const extras = JSON.parse(JSON.stringify(valid)) as typeof valid & { system: { id?: string; __evil?: string } };
extras.system.id = 'attacker-chosen';
(extras.system as { __evil?: string }).__evil = '<script>alert(1)</script>';
const cleaned = parseSystemExport(JSON.stringify(extras));
check('ignores imported system id', !('id' in cleaned.system));
check('ignores unknown fields', !('__evil' in cleaned.system));

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall ok');
