import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { classifyZipEntryName, DEFAULT_ZIP_LIMITS, extractZipSafely } from '../src/utils/zip';
import { AppError } from '../src/utils/errors';

function makeZip(entries: Array<{ name: string; data: Buffer | string }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const e of entries) zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name);
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

/** yazl refuses unsafe names, so write a safe one and patch the bytes (same length). */
function patchName(buf: Buffer, from: string, to: string): Buffer {
  expect(from.length).toBe(to.length);
  return Buffer.from(buf.toString('latin1').split(from).join(to), 'latin1');
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : 'NON_APP_ERROR';
  }
}

describe('zip entry names', () => {
  it('blocks traversal and absolute paths', () => {
    expect(() => classifyZipEntryName('../etc/passwd.pdf')).toThrow(/not allowed/);
    expect(() => classifyZipEntryName('cvs/../../x.pdf')).toThrow();
    expect(() => classifyZipEntryName('/abs/x.pdf')).toThrow();
    expect(() => classifyZipEntryName('C:\\Windows\\x.pdf')).toThrow();
    expect(() => classifyZipEntryName('..\\x.pdf')).toThrow();
  });

  it('blocks nested archives and skips junk / unsupported types', () => {
    expect(() => classifyZipEntryName('inner.zip')).toThrow(/inside the ZIP/);
    expect(classifyZipEntryName('__MACOSX/._a.pdf')).toEqual({ action: 'skip-silent' });
    expect(classifyZipEntryName('folder/')).toEqual({ action: 'skip-silent' });
    expect(classifyZipEntryName('notes.exe')).toEqual({ action: 'skip', name: 'notes.exe', reason: 'UNSUPPORTED_TYPE' });
    expect(classifyZipEntryName('cvs/Aarav.pdf')).toEqual({ action: 'extract', name: 'Aarav.pdf' });
  });
});

describe('extractZipSafely', () => {
  it('extracts allowed files and reports skipped ones', async () => {
    const zip = await makeZip([
      { name: 'a.pdf', data: 'pdf-bytes' },
      { name: 'b.txt', data: 'resume text' },
      { name: 'virus.exe', data: 'x' },
      { name: '.DS_Store', data: 'x' },
    ]);
    const out = await extractZipSafely(zip, zip.length);
    expect(out.files.map((f) => f.name).sort()).toEqual(['a.pdf', 'b.txt']);
    expect(out.skipped).toEqual([{ name: 'virus.exe', reason: 'UNSUPPORTED_TYPE' }]);
  });

  it('rejects path traversal inside a real zip', async () => {
    const zip = patchName(await makeZip([{ name: 'aa/evil.pdf', data: 'x' }]), 'aa/evil.pdf', '../evil.pdf');
    expect(await codeOf(extractZipSafely(zip, zip.length))).toBe('ZIP_UNSAFE_PATH');
  });

  it('rejects nested zips', async () => {
    const zip = await makeZip([{ name: 'inner.zip', data: 'PK' }]);
    expect(await codeOf(extractZipSafely(zip, zip.length))).toBe('ZIP_NESTED_ARCHIVE');
  });

  it('rejects more than 50 entries', async () => {
    const entries = Array.from({ length: 51 }, (_, i) => ({ name: `cv${i}.txt`, data: `resume ${i}` }));
    const zip = await makeZip(entries);
    expect(await codeOf(extractZipSafely(zip, zip.length))).toBe('ZIP_TOO_MANY_FILES');
  });

  it('rejects zips over the compressed size limit', async () => {
    const zip = await makeZip([{ name: 'a.txt', data: 'x' }]);
    expect(await codeOf(extractZipSafely(zip, DEFAULT_ZIP_LIMITS.maxCompressedBytes + 1))).toBe('ZIP_TOO_LARGE');
  });

  it('defends against zip bombs (highly compressible data over the uncompressed limit)', async () => {
    const zeros = Buffer.alloc(3 * 1024 * 1024); // compresses to a few KB
    const zip = await makeZip([
      { name: 'a.txt', data: zeros },
      { name: 'b.txt', data: zeros },
    ]);
    expect(zip.length).toBeLessThan(100 * 1024);
    const limits = { ...DEFAULT_ZIP_LIMITS, maxUncompressedBytes: 4 * 1024 * 1024 };
    expect(await codeOf(extractZipSafely(zip, zip.length, limits))).toBe('ZIP_TOO_LARGE');
  });

  it('skips single entries larger than 5 MB without inflating them', async () => {
    const zip = await makeZip([
      { name: 'huge.pdf', data: Buffer.alloc(6 * 1024 * 1024) },
      { name: 'ok.txt', data: 'resume' },
    ]);
    const out = await extractZipSafely(zip, zip.length);
    expect(out.files.map((f) => f.name)).toEqual(['ok.txt']);
    expect(out.skipped).toEqual([{ name: 'huge.pdf', reason: 'FILE_TOO_LARGE' }]);
  });

  it('rejects garbage that is not a zip', async () => {
    const junk = Buffer.from('definitely not a zip file');
    expect(await codeOf(extractZipSafely(junk, junk.length))).toBe('ZIP_INVALID');
  });
});
