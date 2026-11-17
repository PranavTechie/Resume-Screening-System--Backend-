import { describe, expect, it } from 'vitest';
import { candidateKeys, preflightFile } from '../src/services/batch.service';
import { sha256 } from '../src/services/resumePipeline.service';

describe('duplicate detection', () => {
  it('same bytes -> same hash, any change -> different hash', () => {
    expect(sha256(Buffer.from('resume A'))).toBe(sha256(Buffer.from('resume A')));
    expect(sha256(Buffer.from('resume A'))).not.toBe(sha256(Buffer.from('resume A ')));
  });

  it('normalizes email case/whitespace and phone formatting', () => {
    expect(candidateKeys('  Aarav.Fake@Example.ORG ', null)).toEqual(['e:aarav.fake@example.org']);
    expect(candidateKeys(null, '+91 98765-43210')).toEqual(['p:9876543210']);
    expect(candidateKeys(null, '098765 43210')).toEqual(['p:9876543210']);
    expect(candidateKeys('x@y.in', '9876543210')).toEqual(['e:x@y.in', 'p:9876543210']);
  });

  it('ignores missing or junk contact values', () => {
    expect(candidateKeys('', '')).toEqual([]);
    expect(candidateKeys('not-an-email', '12345')).toEqual([]);
  });
});

describe('preflight (before credits)', () => {
  it('accepts allowed types and infers mime from extension', () => {
    expect(preflightFile({ name: 'cv.PDF', size: 1000, mimeType: 'application/octet-stream' })).toEqual({ ok: true, mimeType: 'application/pdf' });
    expect(preflightFile({ name: 'cv.docx', size: 1000 })).toEqual({
      ok: true,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('rejects wrong type, empty and oversized files', () => {
    expect(preflightFile({ name: 'cv.exe', size: 1000 })).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' });
    expect(preflightFile({ name: 'cv.pdf', size: 0 })).toMatchObject({ ok: false, code: 'EMPTY_FILE' });
    expect(preflightFile({ name: 'cv.pdf', size: 6 * 1024 * 1024 })).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
  });
});
