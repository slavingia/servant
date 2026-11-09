// A small Word (.docx) writer for study readouts. It follows Civic Research
// Studio's Word writer (research-studio-vendor/docx.js, which stays an unchanged
// copy) and reuses its ZIP packaging, but writes bullet points as real Word list
// items, so Word and screen readers treat them as a list, and it sets the
// document's language.
import { zipStore } from "./research-studio-vendor/docx.js";

export type WordRun = { text: string; bold?: boolean };
export type WordBlock =
  | { type: "title" | "h1" | "h2" | "p" | "note"; text: string | WordRun[] }
  | { type: "bullet"; text: string | WordRun[] }
  | { type: "table"; rows: string[][]; widths?: number[] };

const xml = (s: string) => s.replace(/[^\x09\x0A\x0D\x20-퟿-�]/g, "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const runs = (content: string | WordRun[]) => (typeof content === "string" ? [{ text: content }] : content)
  .map(r => `<w:r>${r.bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(r.text)}</w:t></w:r>`).join("");
const para = (content: string | WordRun[], props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runs(content)}</w:p>`;
const STYLE_IDS = { title: "Title", h1: "Heading1", h2: "Heading2", note: "Note", p: "" } as const;

function table(rows: string[][], widths?: number[]) {
  const cols = Math.max(...rows.map(r => r.length));
  const ws = Array.from({ length: cols }, (_, j) => Math.floor(9360 * (widths?.[j] ?? 1 / cols)));
  const border = ["top", "left", "bottom", "right", "insideH", "insideV"].map(b => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="C9D6DB"/>`).join("");
  const cell = (c: string, head: boolean, w: number) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="E6F1F0"/>' : ""}</w:tcPr>${String(c ?? "").split("\n").map(line => para(head ? [{ text: line, bold: true }] : line, '<w:pStyle w:val="TableText"/>')).join("")}</w:tc>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${ws.map(w => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.map((r, i) => `<w:tr>${i === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: cols }, (_, j) => cell(r[j], i === 0, ws[j])).join("")}</w:tr>`).join("")}</w:tbl>${para("")}`;
}

function body(blocks: WordBlock[]) {
  return blocks.map(b => {
    if (b.type === "table") return b.rows.length ? table(b.rows, b.widths) : "";
    // A real list item: the ListBullet style uses list 1 (a bullet).
    if (b.type === "bullet") return para(b.text, '<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    const style = STYLE_IDS[b.type];
    return para(b.text, style ? `<w:pStyle w:val="${style}"/>` : "");
  }).join("");
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="0E2835"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="0A5F63"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1B3544"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="4D6670"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:themeFontLang w:val="en-US"/></w:settings>`;

/** A .docx file of the blocks, with the title and author in its properties. */
export function buildWordDocument(blocks: WordBlock[], { title = "Document", author = "" } = {}, date = new Date()): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body(blocks)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const iso = date.toISOString().replace(/\.\d+Z$/, "Z");
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const part = (name: string, type: string) => `<Override PartName="${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
  return zipStore([
    { name: "[Content_Types].xml", data: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${part("/word/document.xml", "document.main")}${part("/word/styles.xml", "styles")}${part("/word/numbering.xml", "numbering")}${part("/word/settings.xml", "settings")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "officeDocument", "word/document.xml")}<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "styles", "styles.xml")}${rel("rId2", "numbering", "numbering.xml")}${rel("rId3", "settings", "settings.xml")}</Relationships>` },
    { name: "word/document.xml", data: doc },
    { name: "word/styles.xml", data: STYLES },
    { name: "word/numbering.xml", data: NUMBERING },
    { name: "word/settings.xml", data: SETTINGS },
    { name: "docProps/core.xml", data: `${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>${xml(author || "Servant")}</dc:creator><dc:language>en-US</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>` },
  ], date) as Uint8Array;
}
