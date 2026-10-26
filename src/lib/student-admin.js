// src/lib/student-admin.js
// Pure rules for the student database: field checks, CSV parsing and building,
// search/sort/paging limits, and the delete-reference decision. Nothing in this
// file touches the database, so every branch is cheap to test.

export const STUDENT_ID_RE = /^\d{7}$/;
export const NAME_MAX = 40;
export const CLASS_MAX = 24;
export const QUERY_MAX = 50;
export const PAGE_SIZES = [20, 50];
export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_CHARS = 200000;

// Sort keys the API accepts, mapped to the SQL expression each one means.
// The map is also the whitelist, so nothing user supplied reaches the ORDER BY
// clause unless it is a key of this object.
export const STUDENT_SORTS = {
  student_id: 'student_id',
  name: 'name',
  class: 'class',
  points: 'points',       // alias of the points total in the SELECT
  created_at: 'created_at',
};

// Every table that can hold a row pointing at a student. Deleting a student is
// only allowed when all four counts are zero.
export const STUDENT_REFS = [
  { key: 'items', table: 'items', column: 'registered_by', label: 'items they reported', one: 'item they reported' },
  { key: 'claims', table: 'claims', column: 'claimant_id', label: 'claims', one: 'claim' },
  { key: 'ledger', table: 'points_ledger', column: 'student_id', label: 'points entries', one: 'points entry' },
  { key: 'redemptions', table: 'redemptions', column: 'student_id', label: 'orders', one: 'order' },
];

export const STUDENT_CSV_COLUMNS = ['student_id', 'name', 'class', 'points', 'returns', 'created_at'];

const collapse = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ *
 * Single student fields
 * ------------------------------------------------------------------ */

export function cleanStudentId(v) {
  return String(v ?? '').trim();
}

export function validateNewStudent(input = {}) {
  const student_id = cleanStudentId(input.student_id);
  const name = collapse(input.name);
  const cls = collapse(input.class ?? input.class_name);
  if (!STUDENT_ID_RE.test(student_id)) return { ok: false, field: 'student_id', error: 'BAD_STUDENT_ID' };
  if (!name) return { ok: false, field: 'name', error: 'NAME_REQUIRED' };
  if (name.length > NAME_MAX) return { ok: false, field: 'name', error: 'NAME_TOO_LONG' };
  if (!cls) return { ok: false, field: 'class', error: 'CLASS_REQUIRED' };
  if (cls.length > CLASS_MAX) return { ok: false, field: 'class', error: 'CLASS_TOO_LONG' };
  return { ok: true, value: { student_id, name, class: cls } };
}

// Name and class only. At least one of them has to be present.
export function validateStudentPatch(input = {}) {
  const name = collapse(input.name);
  const cls = collapse(input.class ?? input.class_name);
  if (!name && !cls) return { ok: false, error: 'BAD_FIELDS' };
  if (name.length > NAME_MAX) return { ok: false, field: 'name', error: 'NAME_TOO_LONG' };
  if (cls.length > CLASS_MAX) return { ok: false, field: 'class', error: 'CLASS_TOO_LONG' };
  return { ok: true, value: { name, class: cls } };
}

/* ------------------------------------------------------------------ *
 * CSV parsing
 * ------------------------------------------------------------------ */

// RFC 4180 style scanner. Tolerates a BOM, CRLF line endings, quoted fields
// with commas, escaped quotes and newlines inside quotes. Returns physical line
// numbers so the preview can point at the row the user has to fix.
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let cells = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (ch === '\n') { line++; field += '\n'; i++; continue; }
      if (ch === '\r') { i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { cells.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      cells.push(field); rows.push({ line: rowLine, cells });
      cells = []; field = ''; i++; line++; rowLine = line; continue;
    }
    field += ch; i++;
  }
  if (field !== '' || cells.length) { cells.push(field); rows.push({ line: rowLine, cells }); }
  return { rows, unterminated: quoted };
}

const normalizeHeader = (v) => String(v ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '').replace(/[\s-]+/g, '_');

// Reads the header (or falls back to the plain 3 column layout when there is no
// header) and returns one record per data row, without validating yet.
export function parseStudentCsv(text) {
  const parsed = parseCsv(text);
  if (parsed.unterminated) return { ok: false, error: 'CSV_UNTERMINATED_QUOTE' };
  const nonEmpty = parsed.rows.filter((r) => r.cells.some((c) => String(c).trim() !== ''));
  if (!nonEmpty.length) return { ok: false, error: 'CSV_EMPTY' };
  if (nonEmpty.length - 1 > MAX_IMPORT_ROWS) return { ok: false, error: 'TOO_MANY_ROWS' };

  const head = nonEmpty[0].cells.map(normalizeHeader);
  // A header row wins; a plain 3 column file is recognised only when the first
  // cell is already a student id. Anything else is treated as a bad header.
  const looksLikeHeader = head.some((h) => ['student_id', 'name', 'class'].includes(h));
  const looksLikeData = STUDENT_ID_RE.test(String(nonEmpty[0].cells[0] ?? '').trim());
  let index;
  let dataRows;
  if (looksLikeHeader) {
    index = { student_id: head.indexOf('student_id'), name: head.indexOf('name'), class: head.indexOf('class') };
    if (index.student_id < 0 || index.name < 0 || index.class < 0) return { ok: false, error: 'CSV_BAD_HEADER' };
    dataRows = nonEmpty.slice(1);
  } else if (looksLikeData) {
    if (nonEmpty[0].cells.length !== 3) return { ok: false, error: 'CSV_BAD_HEADER' };
    index = { student_id: 0, name: 1, class: 2 };
    dataRows = nonEmpty;
  } else {
    return { ok: false, error: 'CSV_BAD_HEADER' };
  }
  const records = dataRows.map((r) => ({
    line: r.line,
    student_id: collapse(r.cells[index.student_id]),
    name: collapse(r.cells[index.name]),
    class: collapse(r.cells[index.class]),
  }));
  return { ok: true, records };
}

// Full row validation used by the import preview. Errors are codes plus a short
// English sentence the console can show as is.
export function validateImportRows(records) {
  const seen = new Set();
  const rows = [];
  for (const rec of records) {
    const errors = [];
    if (!rec.student_id && !rec.name && !rec.class) continue;      // trailing commas / filler
    if (!STUDENT_ID_RE.test(rec.student_id)) errors.push({ error: 'BAD_STUDENT_ID', message: 'Student ID must be 7 digits.' });
    if (!rec.name) errors.push({ error: 'NAME_REQUIRED', message: 'Name is required.' });
    else if (rec.name.length > NAME_MAX) errors.push({ error: 'NAME_TOO_LONG', message: `Name is longer than ${NAME_MAX} characters.` });
    if (!rec.class) errors.push({ error: 'CLASS_REQUIRED', message: 'Class is required.' });
    else if (rec.class.length > CLASS_MAX) errors.push({ error: 'CLASS_TOO_LONG', message: `Class is longer than ${CLASS_MAX} characters.` });
    if (STUDENT_ID_RE.test(rec.student_id)) {
      if (seen.has(rec.student_id)) errors.push({ error: 'DUPLICATE_IN_CSV', message: 'This student ID appears earlier in the file.' });
      else seen.add(rec.student_id);
    }
    rows.push({
      line: rec.line,
      student_id: rec.student_id,
      name: rec.name,
      class: rec.class,
      error: errors.length ? errors[0].error : null,
      message: errors.length ? errors[0].message : '',
      errors,
    });
  }
  return rows;
}

export function summarizeImport(rows) {
  const total = rows.length;
  const invalid = rows.filter((r) => r.error).length;
  return { total, valid: total - invalid, invalid };
}

/* ------------------------------------------------------------------ *
 * CSV building
 * ------------------------------------------------------------------ */

export function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function buildStudentCsv(records) {
  const lines = [STUDENT_CSV_COLUMNS.join(',')];
  for (const r of records) lines.push(STUDENT_CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * Search, sort, paging
 * ------------------------------------------------------------------ */

// Escapes the LIKE wildcards so a search for "%" only finds a literal percent.
export function escapeLike(q) {
  return '%' + String(q ?? '').replace(/[\\%_]/g, '\\$&') + '%';
}

export function studentOrderBy(sort, dir) {
  const column = STUDENT_SORTS[sort] || STUDENT_SORTS.student_id;
  const direction = dir === 'desc' ? 'DESC' : 'ASC';
  if (column === 'student_id') return `student_id ${direction}`;
  return `${column} ${direction}, student_id ASC`;
}

export function parseStudentQuery(searchParams) {
  const get = (k) => (searchParams?.get ? searchParams.get(k) : null);
  const q = collapse(get('q')).slice(0, QUERY_MAX);
  const pageRaw = Number(get('page'));
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const sizeRaw = Number(get('page_size') ?? get('pageSize'));
  const page_size = PAGE_SIZES.includes(sizeRaw) ? sizeRaw : PAGE_SIZES[0];
  const sortRaw = String(get('sort') ?? '');
  const sort = sortRaw in STUDENT_SORTS ? sortRaw : 'student_id';
  const dir = String(get('dir') ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';
  return { q, page, page_size, sort, dir, like: escapeLike(q), offset: (page - 1) * page_size };
}

export function pageCount(total, pageSize) {
  return Math.max(1, Math.ceil(Number(total || 0) / Number(pageSize || 1)));
}

/* ------------------------------------------------------------------ *
 * Delete guard
 * ------------------------------------------------------------------ */

// Takes the four counts and says whether a delete is allowed. The same shape is
// returned by the API so the console can list exactly what is in the way.
export function deleteDecision(refs = {}) {
  const entries = [];
  let total = 0;
  for (const ref of STUDENT_REFS) {
    const count = Math.max(0, Number(refs[ref.key] || 0));
    if (count > 0) { entries.push({ ...ref, count }); total += count; }
  }
  const counts = {};
  for (const ref of STUDENT_REFS) counts[ref.key] = Math.max(0, Number(refs[ref.key] || 0));
  return { blocked: total > 0, total, entries, refs: counts };
}

export function describeRefs(entries = []) {
  return entries.map((e) => `${e.count} ${e.count === 1 ? e.one : e.label}`).join(', ');
}

export function chunkArray(list, size) {
  const out = [];
  const step = Math.max(1, Number(size) || 1);
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}
