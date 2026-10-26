// tests/admin-students.test.js
// Student database: CSV round trip, validation, search/paging rules and the
// HTTP endpoints behind the Students tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDb } from './fake-db.js';
import { admin } from '../src/api/admin.js';
import {
  parseCsv, parseStudentCsv, validateImportRows, summarizeImport, buildStudentCsv, csvCell,
  validateNewStudent, validateStudentPatch, escapeLike, parseStudentQuery, studentOrderBy,
  deleteDecision, describeRefs, chunkArray,
} from '../src/lib/student-admin.js';

const SCHEMA = readFileSync('schema.sql', 'utf8');
const env = { ADMIN_TOKEN: 'T0KEN' };

const req = (path, method = 'GET', body = null) => new Request('https://x' + path, {
  method,
  headers: { 'X-Admin-Token': 'T0KEN', ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const call = (db, path, method = 'GET', body = null) => admin(db, env, req(path, method, body), 'T0KEN');
const json = async (res) => ({ status: res.status, body: await res.json() });

async function dbWithTwoStudents() {
  const db = fakeDb(SCHEMA);
  await db.prepare("INSERT INTO identities(student_id,name,class,created_at) VALUES ('9031622','Alex Wang','7(3)','2026-10-01 08:00:00')").run();
  await db.prepare("INSERT INTO identities(student_id,name,class,created_at) VALUES ('9031623','Leo Li','7(3)','2026-10-02 08:00:00')").run();
  return db;
}

/* ------------------------------------------------------------------ *
 * Pure: CSV parsing
 * ------------------------------------------------------------------ */

test('CSV parse: BOM, CRLF, quoted comma and escaped quote', () => {
  const csv = '\uFEFFstudent_id,name,class\r\n9031622,"Wang, Alex",7(3)\r\n9031623,"Lee ""Leo"" Li",7(3)\r\n';
  const out = parseStudentCsv(csv);
  assert.equal(out.ok, true);
  assert.equal(out.records.length, 2);
  assert.deepEqual(out.records[0], { line: 2, student_id: '9031622', name: 'Wang, Alex', class: '7(3)' });
  assert.equal(out.records[1].name, 'Lee "Leo" Li');
  assert.equal(out.records[1].line, 3);
});

test('CSV parse: headerless 3 columns still works', () => {
  const out = parseStudentCsv('9031622,Alex Wang,7(3)\n9031623,Leo Li,7(3)\n');
  assert.equal(out.ok, true);
  assert.equal(out.records[0].student_id, '9031622');
  assert.equal(out.records[1].name, 'Leo Li');
});

test('CSV parse: exported 6 column file can be imported again (extra columns ignored)', () => {
  const exported = buildStudentCsv([
    { student_id: '9031622', name: 'Alex Wang', class: '7(3)', points: 25, returns: 2, created_at: '2026-10-01 08:00:00' },
  ]);
  const out = parseStudentCsv(exported);
  assert.equal(out.ok, true);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].points, undefined);
  assert.equal(out.records[0].student_id, '9031622');
});

test('CSV parse: rejects bad header, empty input, unterminated quote and too many rows', () => {
  assert.equal(parseStudentCsv('').error, 'CSV_EMPTY');
  assert.equal(parseStudentCsv('id,full_name,room\n1,2,3').error, 'CSV_BAD_HEADER');
  assert.equal(parseStudentCsv('student_id,name,class\n"9031622,Alex,7(3)').error, 'CSV_UNTERMINATED_QUOTE');
  const many = ['student_id,name,class'].concat(Array.from({ length: 1001 }, (_, i) => `${String(1000000 + i)},N,C`)).join('\n');
  assert.equal(parseStudentCsv(many).error, 'TOO_MANY_ROWS');
});

test('CSV validation: bad id, missing name, missing class, duplicates, blank filler rows', () => {
  const parsed = parseStudentCsv([
    'student_id,name,class',
    '12345,Short Id,7(3)',            // bad id
    '9031622,,7(3)',                  // no name
    '9031623,Leo Li,',                // no class
    '9031624,Mia Chen,8(1)',
    '9031624,Mia Again,8(2)',         // duplicate id
    ',,',                             // filler row, skipped
  ].join('\n'));
  const rows = validateImportRows(parsed.records);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].error, 'BAD_STUDENT_ID');
  assert.equal(rows[1].error, 'NAME_REQUIRED');
  assert.equal(rows[2].error, 'CLASS_REQUIRED');
  assert.equal(rows[3].error, null);
  assert.equal(rows[4].error, 'DUPLICATE_IN_CSV');
  assert.equal(rows[4].line, 6);
  assert.deepEqual(summarizeImport(rows), { total: 5, valid: 1, invalid: 4 });
});

test('CSV build: quotes cells and round trips through the parser', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  const csv = buildStudentCsv([
    { student_id: '9031622', name: 'Wang, Alex', class: '7(3)', points: 0, returns: 0, created_at: '2026-10-01 08:00:00' },
    { student_id: '9031623', name: 'Lee "Leo" Li', class: '7(3)', points: 95, returns: 7, created_at: '2026-10-02 08:00:00' },
  ]);
  assert.match(csv, /^student_id,name,class,points,returns,created_at\r\n/);
  const parsed = parseStudentCsv(csv);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.records[1].name, 'Lee "Leo" Li');
});

/* ------------------------------------------------------------------ *
 * Pure: fields, search, sort, delete guard
 * ------------------------------------------------------------------ */

test('new student fields: 7 digit id, name and class required, length limits', () => {
  assert.equal(validateNewStudent({ student_id: '123456', name: 'A', class: 'B' }).error, 'BAD_STUDENT_ID');
  assert.equal(validateNewStudent({ student_id: '9031622', name: '  ', class: 'B' }).error, 'NAME_REQUIRED');
  assert.equal(validateNewStudent({ student_id: '9031622', name: 'A', class: '' }).error, 'CLASS_REQUIRED');
  assert.equal(validateNewStudent({ student_id: '9031622', name: 'x'.repeat(41), class: 'B' }).error, 'NAME_TOO_LONG');
  assert.equal(validateNewStudent({ student_id: '9031622', name: '  Alex   Wang ', class: ' 7(3) ' }).value.name, 'Alex Wang');
  assert.equal(validateStudentPatch({}).error, 'BAD_FIELDS');
  assert.equal(validateStudentPatch({ name: 'New Name' }).ok, true);
});

test('query rules: defaults, page size whitelist, sort whitelist, like escaping', () => {
  const d = parseStudentQuery(new URLSearchParams(''));
  assert.deepEqual([d.page, d.page_size, d.sort, d.dir], [1, 20, 'student_id', 'asc']);
  const p = parseStudentQuery(new URLSearchParams('q=9031&page=3&page_size=50&sort=points&dir=DESC'));
  assert.deepEqual([p.q, p.page, p.page_size, p.sort, p.dir], ['9031', 3, 50, 'points', 'desc']);
  const odd = parseStudentQuery(new URLSearchParams('page=-2&page_size=7&sort=nope%3BDROP%20TABLE&dir=sideways'));
  assert.deepEqual([odd.page, odd.page_size, odd.sort, odd.dir], [1, 20, 'student_id', 'asc']);
  assert.equal(escapeLike('50%'), '%50\\%%');
  assert.equal(escapeLike('a_b'), '%a\\_b%');
  assert.equal(escapeLike('c\\d'), '%c\\\\d%');
  assert.equal(studentOrderBy('points', 'desc'), 'points DESC, student_id ASC');
  assert.equal(studentOrderBy('name', 'asc'), 'name ASC, student_id ASC');
  assert.equal(studentOrderBy('student_id', 'desc'), 'student_id DESC');
});

test('delete guard: clean students pass, any reference blocks with counts', () => {
  assert.equal(deleteDecision({ items: 0, claims: 0, ledger: 0, redemptions: 0 }).blocked, false);
  const blocked = deleteDecision({ items: 5, claims: 2, ledger: 40, redemptions: 1 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.total, 48);
  assert.deepEqual(blocked.refs, { items: 5, claims: 2, ledger: 40, redemptions: 1 });
  assert.equal(describeRefs(blocked.entries), '5 items they reported, 2 claims, 40 points entries, 1 order');
  assert.equal(chunkArray([1, 2, 3, 4, 5], 2).length, 3);
});

/* ------------------------------------------------------------------ *
 * API: list + stats
 * ------------------------------------------------------------------ */

test('GET /students: stats, search by id/name/class, paging and sorting', async () => {
  const db = await dbWithTwoStudents();
  await db.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031700','Zoe Park','8(1)')").run();
  // Alex: reported 3 items (2 returned), 1 claim pending, ledger 25, 1 order
  for (let i = 0; i < 3; i++) {
    await db.prepare(`INSERT INTO items(code,title,category,location,status,registered_by,registered_via,found_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(`LF-T-000${i}`, 'Thing', 'other', 'Hall', i < 2 ? 'returned' : 'in_stock', '9031622', 'phone', '2026-10-01T00:00:00Z').run();
  }
  const itemId = (await db.prepare("SELECT id FROM items LIMIT 1").first()).id;
  await db.prepare("INSERT INTO claims(item_id,claimant_id,status,pickup_expires_at) VALUES (?, '9031622','pending','2099-01-01T00:00:00Z')").bind(itemId).run();
  await db.prepare(`INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',25,'claim_reward','2026-10')`).run();
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock) VALUES (5,'Pen','Pen',10,5)").run();
  await db.prepare("INSERT INTO redemptions(student_id,reward_id,points_cost) VALUES ('9031622',5,10)").run();

  const all = await json(await call(db, '/api/admin/students'));
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 3);
  assert.equal(all.body.students.length, 3);
  const alex = all.body.students.find((s) => s.student_id === '9031622');
  assert.equal(alex.points, 25);
  assert.equal(alex.handed_in, 3);
  assert.equal(alex.returns, 2);
  assert.equal(alex.active_claims, 1);
  assert.equal(alex.orders, 1);
  assert.equal(alex.has_pin, 0);

  const byId = await json(await call(db, '/api/admin/students?q=90317'));
  assert.equal(byId.body.total, 1);
  assert.equal(byId.body.students[0].name, 'Zoe Park');
  const byName = await json(await call(db, '/api/admin/students?q=leo'));
  assert.equal(byName.body.total, 1);
  const byClass = await json(await call(db, '/api/admin/students?q=8(1)'));
  assert.equal(byClass.body.total, 1);

  // "%" is escaped, so it must not match everyone.
  assert.equal((await json(await call(db, '/api/admin/students?q=%25'))).body.total, 0);

  const sorted = await json(await call(db, '/api/admin/students?sort=points&dir=desc&page_size=50'));
  assert.equal(sorted.body.students[0].student_id, '9031622');
  assert.equal(sorted.body.page_size, 50);

  db._sql.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031701','Extra One','9(1)')").run();
  db._sql.prepare("INSERT INTO identities(student_id,name,class) VALUES ('9031702','Extra Two','9(1)')").run();
  for (let i = 0; i < 17; i++) {
    db._sql.prepare('INSERT INTO identities(student_id,name,class) VALUES (?,?,?)')
      .run(`90318${String(i).padStart(2, '0')}`, `Filler ${i}`, '9(2)');
  }
  const page2 = await json(await call(db, '/api/admin/students?page=2&page_size=20'));
  assert.equal(page2.body.total, 22);
  assert.equal(page2.body.page, 2);
  assert.equal(page2.body.pages, 2);
  assert.equal(page2.body.students.length, 2);
  const clamped = await json(await call(db, '/api/admin/students?page=99&page_size=20'));
  assert.equal(clamped.body.page, 2);               // clamped to the last page
  assert.equal(clamped.body.students.length, 2);
});

/* ------------------------------------------------------------------ *
 * API: create / update / reset pin
 * ------------------------------------------------------------------ */

test('POST /students: create, duplicate 409, bad fields 400, optional PIN', async () => {
  const db = fakeDb(SCHEMA);
  const created = await json(await call(db, '/api/admin/students', 'POST', { student_id: '9031622', name: 'Alex Wang', class: '7(3)' }));
  assert.equal(created.status, 200);
  assert.equal(created.body.student.has_pin, false);
  assert.equal((await db.prepare("SELECT name FROM identities WHERE student_id='9031622'").first()).name, 'Alex Wang');

  assert.equal((await call(db, '/api/admin/students', 'POST', { student_id: '9031622', name: 'Other', class: '7(3)' })).status, 409);
  assert.equal((await call(db, '/api/admin/students', 'POST', { student_id: '123', name: 'A', class: 'B' })).status, 400);
  assert.equal((await call(db, '/api/admin/students', 'POST', { student_id: '9031623', name: 'A', class: 'B', pin: '12' })).status, 400);

  const withPin = await json(await call(db, '/api/admin/students', 'POST', { student_id: '9031624', name: 'Mia Chen', class: '8(1)', pin: '4321' }));
  assert.equal(withPin.status, 200);
  assert.equal(withPin.body.student.has_pin, true);
  assert.match((await db.prepare("SELECT pin_hash FROM identities WHERE student_id='9031624'").first()).pin_hash, /^.+\$.+$/);
  const audit = await db.prepare("SELECT action, detail FROM admin_audit WHERE action='student_create' ORDER BY id").all();
  assert.equal(audit.results.length, 2);
  assert.match(audit.results[0].detail, /pin:none/);
  assert.match(audit.results[1].detail, /pin:set/);
});

test('POST /students/update: rename and class change, 404 and 400 paths', async () => {
  const db = await dbWithTwoStudents();
  const ok = await json(await call(db, '/api/admin/students/update', 'POST', { student_id: '9031622', name: '  Alex  W. Wang ' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.student.name, 'Alex W. Wang');
  assert.equal(ok.body.student.class, '7(3)');

  const cls = await json(await call(db, '/api/admin/students/update', 'POST', { student_id: '9031623', class: '8(2)' }));
  assert.equal(cls.body.student.class, '8(2)');
  assert.equal(cls.body.student.name, 'Leo Li');

  assert.equal((await call(db, '/api/admin/students/update', 'POST', { student_id: '9031699', name: 'X' })).status, 404);
  assert.equal((await call(db, '/api/admin/students/update', 'POST', { student_id: '9031622' })).status, 400);
  assert.equal((await call(db, '/api/admin/students/update', 'POST', { student_id: 'oops', name: 'X' })).status, 400);
});

test('POST /students/reset-pin: single and batch, missing ids reported', async () => {
  const db = await dbWithTwoStudents();
  await db.prepare("UPDATE identities SET pin_hash='salt$hash'").run();
  const one = await json(await call(db, '/api/admin/students/reset-pin', 'POST', { student_id: '9031622' }));
  assert.equal(one.status, 200);
  assert.equal(one.body.results[0].status, 'reset');
  assert.equal((await db.prepare("SELECT pin_hash FROM identities WHERE student_id='9031622'").first()).pin_hash, null);

  await db.prepare("UPDATE identities SET pin_hash='salt$hash'").run();
  const two = await json(await call(db, '/api/admin/students/reset-pin', 'POST', { student_ids: ['9031622', '9031623', '9999999'] }));
  assert.equal(two.body.reset, 2);
  assert.deepEqual(two.body.results.map((r) => r.status), ['reset', 'reset', 'not_found']);
});

/* ------------------------------------------------------------------ *
 * API: protected delete
 * ------------------------------------------------------------------ */

test('POST /students/delete: clean student deletes, referenced student gets 409 with counts', async () => {
  const db = await dbWithTwoStudents();
  await db.prepare(`INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',10,'claim_reward','2026-10')`).run();
  await db.prepare(`INSERT INTO items(code,title,category,location,status,registered_by,registered_via,found_at)
    VALUES ('LF-T-1','Thing','other','Hall','in_stock','9031622','phone','2026-10-01T00:00:00Z')`).run();

  const blocked = await json(await call(db, '/api/admin/students/delete', 'POST', { student_id: '9031622' }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'STUDENT_IN_USE');
  assert.deepEqual(blocked.body.refs, { items: 1, claims: 0, ledger: 1, redemptions: 0 });
  assert.equal(blocked.body.summary, '1 item they reported, 1 points entry');
  assert.ok(await db.prepare("SELECT 1 FROM identities WHERE student_id='9031622'").first());

  const ok = await json(await call(db, '/api/admin/students/delete', 'POST', { student_id: '9031623' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.deleted, true);
  assert.equal(await db.prepare("SELECT 1 FROM identities WHERE student_id='9031623'").first(), null);
  assert.equal((await call(db, '/api/admin/students/delete', 'POST', { student_id: '9031623' })).status, 404);
});

test('GET /students/refs: reports blockers before the confirm dialog', async () => {
  const db = await dbWithTwoStudents();
  await db.prepare("INSERT INTO rewards(id,name,name_en,cost,stock) VALUES (5,'Pen','Pen',10,5)").run();
  await db.prepare("INSERT INTO redemptions(student_id,reward_id,points_cost) VALUES ('9031622',5,10)").run();
  const r = await json(await call(db, '/api/admin/students/refs?student_id=9031622'));
  assert.equal(r.status, 200);
  assert.equal(r.body.blocked, true);
  assert.equal(r.body.refs.redemptions, 1);
  assert.equal((await call(db, '/api/admin/students/refs?student_id=9031699')).status, 404);
});

test('POST /students/delete batch: per row results for deleted, blocked, not found', async () => {
  const db = await dbWithTwoStudents();
  await db.prepare(`INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',10,'claim_reward','2026-10')`).run();
  const r = await json(await call(db, '/api/admin/students/delete', 'POST', { student_ids: ['9031622', '9031623', '9999999'] }));
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 1);
  assert.equal(r.body.blocked, 1);
  assert.equal(r.body.not_found, 1);
  const byId = Object.fromEntries(r.body.results.map((x) => [x.student_id, x.status]));
  assert.deepEqual(byId, { 9031622: 'blocked', 9031623: 'deleted', 9999999: 'not_found' });
});

test('POST /students/delete race: a reference that appears after the check returns 409, not 500', async () => {
  const db = await dbWithTwoStudents();
  const realPrepare = db.prepare.bind(db);
  let injected = false;
  db.prepare = (sql) => {
    if (!injected && sql.startsWith('DELETE FROM identities')) {
      injected = true;
      // A points entry lands after the count but before the delete runs, so the
      // real D1 foreign key would make the DELETE throw.
      db._sql.prepare("INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031623',1,'adjust','2026-10')").run();
      throw new Error('FOREIGN KEY constraint failed');
    }
    return realPrepare(sql);
  };
  const res = await json(await call(db, '/api/admin/students/delete', 'POST', { student_id: '9031623' }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'STUDENT_IN_USE');
  assert.equal(res.body.refs.ledger, 1);
});

/* ------------------------------------------------------------------ *
 * API: bulk
 * ------------------------------------------------------------------ */

test('POST /students/bulk: set_class and reset_pin on a selection', async () => {
  const db = await dbWithTwoStudents();
  const classRes = await json(await call(db, '/api/admin/students/bulk', 'POST', { student_ids: ['9031622', '9031623'], action: 'set_class', class: ' 8(1) ' }));
  assert.equal(classRes.status, 200);
  assert.equal(classRes.body.updated, 2);
  assert.equal((await db.prepare("SELECT class FROM identities WHERE student_id='9031623'").first()).class, '8(1)');
  assert.equal((await call(db, '/api/admin/students/bulk', 'POST', { student_ids: ['9031622'], action: 'set_class', class: '  ' })).status, 400);
  assert.equal((await call(db, '/api/admin/students/bulk', 'POST', { student_ids: ['9031622'], action: 'nuke' })).status, 400);

  await db.prepare("UPDATE identities SET pin_hash='salt$hash'").run();
  const pinRes = await json(await call(db, '/api/admin/students/bulk', 'POST', { student_ids: ['9031622', '9031623'], action: 'reset_pin' }));
  assert.equal(pinRes.body.reset, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM identities WHERE pin_hash IS NOT NULL").first()).c, 0);
});

/* ------------------------------------------------------------------ *
 * API: CSV import two step + export
 * ------------------------------------------------------------------ */

test('POST /students/import: preview writes nothing, commit creates and updates, failures reported', async () => {
  const db = await dbWithTwoStudents();
  const csv = [
    'student_id,name,class',
    '9031622,Alex W. Wang,7(4)',      // update
    '9031700,New Student,9(1)',       // create
    '12345,Bad Id,9(1)',              // error
  ].join('\n');

  const preview = await json(await call(db, '/api/admin/students/import', 'POST', { csv, confirm: false }));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.mode, 'preview');
  assert.deepEqual(
    { total: preview.body.summary.total, valid: preview.body.summary.valid, invalid: preview.body.summary.invalid, create: preview.body.summary.create, update: preview.body.summary.update },
    { total: 3, valid: 2, invalid: 1, create: 1, update: 1 },
  );
  assert.equal(preview.body.rows[0].action, 'update');
  assert.equal(preview.body.rows[2].action, 'error');
  assert.equal((await db.prepare('SELECT COUNT(*) AS c FROM identities').first()).c, 2);   // no writes

  const commit = await json(await call(db, '/api/admin/students/import', 'POST', { csv, confirm: true }));
  assert.equal(commit.status, 200);
  assert.equal(commit.body.mode, 'commit');
  assert.equal(commit.body.summary.created, 1);
  assert.equal(commit.body.summary.updated, 1);
  assert.equal(commit.body.summary.failed, 1);
  assert.equal(commit.body.summary.applied, 2);
  assert.equal((await db.prepare("SELECT name, class FROM identities WHERE student_id='9031622'").first()).name, 'Alex W. Wang');
  assert.equal((await db.prepare("SELECT class FROM identities WHERE student_id='9031700'").first()).class, '9(1)');
  const failed = commit.body.results.find((r) => r.line === 4);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'BAD_STUDENT_ID');
  assert.ok(await db.prepare("SELECT 1 FROM admin_audit WHERE action='students_import'").first());

  assert.equal((await call(db, '/api/admin/students/import', 'POST', { csv: '', confirm: false })).status, 400);
  assert.equal((await call(db, '/api/admin/students/import', 'POST', { csv: 'id,full_name\n1,2', confirm: false })).status, 400);
});

test('GET /students/export: BOM, fixed header, point and return totals', async () => {
  const db = await dbWithTwoStudents();
  await db.prepare(`INSERT INTO points_ledger(student_id,delta,reason,month_key) VALUES ('9031622',25,'claim_reward','2026-10')`).run();
  await db.prepare(`INSERT INTO items(code,title,category,location,status,registered_by,registered_via,found_at)
    VALUES ('LF-T-1','Thing','other','Hall','returned','9031622','phone','2026-10-01T00:00:00Z')`).run();
  const res = await call(db, '/api/admin/students/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /lf-students-\d{4}-\d{2}-\d{2}\.csv/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);          // BOM for Excel
  const text = new TextDecoder().decode(bytes.slice(3));
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0], 'student_id,name,class,points,returns,created_at');
  assert.equal(lines[1], '9031622,Alex Wang,7(3),25,1,2026-10-01 08:00:00');
  assert.match(lines[2], /^9031623,Leo Li,7\(3\),0,0,/);
});
