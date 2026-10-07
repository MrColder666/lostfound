import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
test('schema 建表齐全', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('schema.sql', 'utf8'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['identities','items','claims','points_ledger','rewards','redemptions','risk_flags','admin_audit'])
    assert.ok(tables.includes(t), `缺表 ${t}`);
});
