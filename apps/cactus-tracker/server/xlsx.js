'use strict';
/*
 * Minimal .xlsx writer — zero dependencies (node:zlib for deflate, hand-rolled CRC32).
 *
 * Why not a library: the tracker runs on `express` alone (see package.json) and the
 * office PC updates itself with `git pull` + restart, so a new npm dependency would
 * mean a manual `npm install` on that machine. This file is ~150 lines and produces a
 * real OOXML workbook Excel / Numbers / Google Sheets open without complaint:
 *   - several sheets, bold header row with fill, frozen header, autofilter
 *   - numbers stored as numbers, everything else as inline strings
 *   - column widths, optional HYPERLINK formula cells ({ url, text })
 *
 * Usage:
 *   const { buildXlsx } = require('./xlsx');
 *   const buf = buildXlsx([{ name: 'Subs', columns: [{ header: 'Company', key: 'company', width: 30 }], rows: [{ company: 'K&S' }] }]);
 */
const zlib = require('zlib');

// ---------- CRC32 (zip needs it per entry) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- zip (deflate entries, no zip64: workbooks here are a few hundred KB) ----------
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // time/date: fixed (1980-01-01 00:00) — irrelevant for Excel
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- OOXML ----------
const xml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // control chars are illegal in XML 1.0
function colRef(i) { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function safeSheetName(n, used) {
  let s = String(n || 'Sheet').replace(/[\\/*?:\[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let base = s, k = 2;
  while (used.has(s.toLowerCase())) { const suf = ' (' + (k++) + ')'; s = base.slice(0, 31 - suf.length) + suf; }
  used.add(s.toLowerCase());
  return s;
}

function cellXml(ref, v, styleId) {
  const s = styleId ? ` s="${styleId}"` : '';
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === 'object' && v.url) {
    // HYPERLINK formula: clickable in Excel without a relationships part
    const txt = String(v.text || v.url).slice(0, 250);
    return `<c r="${ref}" s="${styleId || 3}" t="str"><f>HYPERLINK("${xml(v.url).replace(/"/g, '""')}","${xml(txt).replace(/"/g, '""')}")</f><v>${xml(txt)}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(String(v).slice(0, 32000))}</t></is></c>`;
}

function sheetXml(sheet) {
  const cols = sheet.columns || [];
  const rows = sheet.rows || [];
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
  const lastCol = colRef(Math.max(cols.length - 1, 0));
  out.push(`<sheetViews><sheetView workbookViewId="0"${sheet.active ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`);
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (cols.length) {
    out.push('<cols>' + cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(c.width) > 0 ? Number(c.width) : 14}" customWidth="1"/>`).join('') + '</cols>');
  }
  out.push('<sheetData>');
  out.push(`<row r="1">${cols.map((c, i) => cellXml(colRef(i) + '1', c.header || c.key, 1)).join('')}</row>`);
  rows.forEach((r, ri) => {
    const rn = ri + 2;
    const cells = cols.map((c, ci) => {
      let v = typeof c.value === 'function' ? c.value(r) : r[c.key];
      if (c.type === 'number' && v !== '' && v != null && !isNaN(Number(v))) v = Number(v);
      return cellXml(colRef(ci) + rn, v, c.style || (c.wrap ? 2 : 0));
    }).join('');
    out.push(`<row r="${rn}">${cells}</row>`);
  });
  out.push('</sheetData>');
  if (cols.length) out.push(`<autoFilter ref="A1:${lastCol}${rows.length + 1}"/>`);
  out.push('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
  out.push('</worksheet>');
  return out.join('');
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF3F7080"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF31353A"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                   // 0 normal
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>' + // 1 header
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' + // 2 wrap
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                     // 3 link
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** sheets: [{ name, columns:[{header,key,width,type:'number',wrap,value(fn)}], rows:[{}] }] → Buffer */
function buildXlsx(sheets) {
  const used = new Set();
  const list = (sheets && sheets.length ? sheets : [{ name: 'Sheet1', columns: [], rows: [] }]).map((s, i) => ({ ...s, name: safeSheetName(s.name, used), active: i === 0 }));
  const files = [];
  files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    list.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' });
  files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' });
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  files.push({ name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:creator>Milestone Tracker</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>` });
  files.push({ name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Milestone Tracker</Application></Properties>' });
  files.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="10000"/></bookViews><sheets>' +
    list.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets><definedNames>' +
    list.map((s, i) => (s.columns || []).length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(s.name).replace(/'/g, "''")}'!$A$1:$${colRef(s.columns.length - 1)}$${(s.rows || []).length + 1}</definedName>` : '').join('') +
    '</definedNames></workbook>' });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: STYLES });
  list.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zip(files);
}

module.exports = { buildXlsx };
