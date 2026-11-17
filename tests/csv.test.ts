import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from '../src/utils/csv';

describe('CSV injection escaping', () => {
  it.each(['=HYPERLINK("http://evil","x")', '+cmd|calc', '-2+3', '@SUM(A1:A9)', '\t=1', '\r=1'])('neutralizes %s', (v) => {
    const out = escapeCsvCell(v);
    expect(out.replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves normal values alone and quotes commas, quotes and newlines', () => {
    expect(escapeCsvCell('Aarav Fake')).toBe('Aarav Fake');
    expect(escapeCsvCell(87)).toBe('87');
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvCell(null)).toBe('');
  });

  it('joins arrays and escapes a dangerous first item', () => {
    expect(escapeCsvCell(['React', 'SQL'])).toBe('React; SQL');
    expect(escapeCsvCell(['=1+1', 'SQL'])).toBe("'=1+1; SQL");
  });

  it('builds a full CSV with BOM and CRLF', () => {
    const csv = toCsv(['Name', 'Score'], [['=evil()', 90]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("Name,Score\r\n'=evil(),90\r\n");
  });
});
