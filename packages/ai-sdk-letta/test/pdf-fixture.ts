/**
 * Pure-JavaScript PDF writer for test fixtures: text pages (Helvetica) and
 * "scanned" pages (one grayscale image, no text layer). Deterministic output.
 *
 * Regenerate the committed fixture with:
 *   node --import tsx packages/ai-sdk-letta/test/pdf-fixture.ts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type FixturePage = { text: string[] } | { image: { width: number; height: number; gray: Uint8Array } };

export function buildPdf(pages: FixturePage[], info: { title?: string } = {}): Buffer {
  const objects: (string | { dict: string; stream: Buffer })[] = [];
  const add = (body: string | { dict: string; stream: Buffer }) => { objects.push(body); return objects.length; };
  const catalog = add(''), pagesId = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  const escape = (s: string) => s.replace(/[\\()]/g, m => `\\${m}`);
  for (const page of pages) {
    let content: string;
    let resources = `/Font << /F1 ${font} 0 R >>`;
    if ('text' in page) content = `BT /F1 11 Tf 72 740 Td 15 TL ${page.text.map(line => `(${escape(line)}) '`).join(' ')} ET`;
    else {
      const { width, height, gray } = page.image;
      const data = deflateSync(Buffer.from(gray), { level: 9 });
      const image = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`, stream: data });
      resources += ` /XObject << /Im1 ${image} 0 R >>`;
      content = `q 468 0 0 ${Math.round(468 * height / width)} 72 400 cm /Im1 Do Q`;
    }
    const stream = Buffer.from(content, 'latin1');
    const contents = add({ dict: `<< /Length ${stream.length} >>`, stream });
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contents} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const infoId = info.title ? add(`<< /Title (${escape(info.title)}) /Producer (ai-sdk-letta test fixture) >>`) : undefined;
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(offset);
    const parts = typeof object === 'string'
      ? [Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`, 'latin1')]
      : [Buffer.from(`${i + 1} 0 obj\n${object.dict}\nstream\n`, 'latin1'), object.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
    for (const part of parts) { chunks.push(part); offset += part.length; }
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** 5×7 bitmap glyphs for the characters the scanned page uses. */
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'], E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'], S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'], '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'], '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'], ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
};
/** Render text lines as a white grayscale bitmap with black glyphs (a fake scan). */
export function bitmapText(lines: string[], scale = 8, margin = 24): { width: number; height: number; gray: Uint8Array } {
  const columns = Math.max(...lines.map(line => line.length));
  const width = margin * 2 + columns * 6 * scale;
  const height = margin * 2 + lines.length * 9 * scale;
  const gray = new Uint8Array(width * height).fill(255);
  lines.forEach((line, row) => [...line].forEach((char, column) => {
    const glyph = GLYPHS[char] ?? GLYPHS[' ']!;
    glyph.forEach((bits, gy) => [...bits].forEach((bit, gx) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        gray[(margin + row * 9 * scale + gy * scale + dy) * width + margin + column * 6 * scale + gx * scale + dx] = 0;
      }
    }));
  }));
  return { width, height, gray };
}

/** The committed `fixtures/quarterly-report.pdf`: 4 text pages and 1 scanned page. */
export function quarterlyReport(): Buffer {
  return buildPdf([
    { text: ['Quarterly Report Q3', 'Northwind Analytics', '', 'Summary: revenue grew while costs stayed flat.', 'See page 3 for the budget and page 4 for staffing.'] },
    { text: ['Revenue', '', 'Total revenue for Q3 was 4.2 million euros.', 'Subscriptions contributed 61 percent of revenue.'] },
    { text: ['Budget', '', 'The marketing budget for Q4 is 380,000 euros.', 'The research budget for Q4 is 1.1 million euros.', 'Budget owner: Ines Duarte.'] },
    { text: ['Staffing', '', 'Headcount at the end of Q3: 57 people.', 'Open roles: 6, mostly in engineering.'] },
    { image: bitmapText(['SCAN CODE:', 'ZEPRA 4797']) },
  ], { title: 'Quarterly Report Q3' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = fileURLToPath(new URL('./fixtures/quarterly-report.pdf', import.meta.url));
  writeFileSync(target, quarterlyReport());
  console.log(`wrote ${target}`);
}
