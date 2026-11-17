/**
 * CSV helpers with formula-injection protection.
 * Cells starting with = + - @ (or tab / carriage return) are prefixed with a single quote
 * so spreadsheet apps treat them as text instead of executing them.
 */
const BOM = String.fromCharCode(0xfeff);
const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = Array.isArray(value) ? value.join('; ') : String(value);
  if (DANGEROUS_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  // BOM so Excel opens UTF-8 (Hindi names, ₹) correctly.
  return BOM + lines.join('\r\n') + '\r\n';
}
