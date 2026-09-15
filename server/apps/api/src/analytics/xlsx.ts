/**
 * 零依赖最小 XLSX 写入器（15 FR-06 Excel 导出；对齐 09 `quote-pdf` 的零依赖思路）。
 *
 * 生成 ZIP（stored 不压缩）承载 OOXML SpreadsheetML 最小部件集：
 *   [Content_Types].xml / _rels/.rels / xl/workbook.xml / xl/_rels/workbook.xml.rels
 *   / xl/worksheets/sheetN.xml
 * 单元格使用 inlineStr（免 sharedStrings）与数值，Excel / WPS / Numbers 均可直接打开。
 */

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
  /** 工作表名（自动规整非法字符并截断 31 字符） */
  name: string;
  rows: XlsxCell[][];
}

// ===== CRC32（ZIP 必需） =====

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data.readUInt8(i)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ===== ZIP（stored） =====

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** DOS 时间戳（固定基准，避免引入时区差异） */
function dosDateTime(): { time: number; date: number } {
  const now = new Date();
  const year = Math.max(1980, now.getFullYear());
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

/** 组装 ZIP（method=0 stored，UTF-8 文件名 flag=0x0800） */
function zipStore(entries: ZipEntry[]): Buffer {
  const { time, date } = dosDateTime();
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

// ===== OOXML =====

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[[\\/*?:\]]/g, '_').trim();
  const fallback = cleaned.length > 0 ? cleaned : `Sheet${index + 1}`;
  return fallback.slice(0, 31);
}

/** 列号 → Excel 列字母（0 → A，26 → AA） */
function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellXml(ref: string, cell: XlsxCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return '';
    return `<c r="${ref}"><v>${cell}</v></c>`;
  }
  const text = String(cell);
  if (text.length === 0) return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(rows: XlsxCell[][]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, colIndex) => cellXml(`${columnLetter(colIndex)}${rowIndex + 1}`, cell))
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');
  return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function contentTypesXml(sheetCount: number): string {
  const overrides = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    `${overrides}</Types>`
  );
}

function workbookXml(sheetNames: string[]): string {
  const sheets = sheetNames
    .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return (
    `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets></workbook>`
  );
}

function workbookRelsXml(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

const ROOT_RELS =
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

/** 生成 XLSX 二进制（至少 1 个工作表） */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const effective = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
  const names = effective.map((sheet, i) => sanitizeSheetName(sheet.name, i));

  const parts: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(effective.length), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(names), 'utf8') },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(workbookRelsXml(effective.length), 'utf8'),
    },
    ...effective.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(sheet.rows), 'utf8'),
    })),
  ];

  return zipStore(parts);
}
