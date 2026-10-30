// archiver v8: the class, not a factory (as in gobd-export.service.ts)
const archiverLib = require('archiver')

/**
 * Tier 748 — a small Markdown document as a Word file (.docx).
 *
 * For what is meant to be edited in Word: the Verfahrensdokumentation goes to
 * the owner and the Steuerberater, who complete it. A .docx is a ZIP of a few
 * XML parts; no library is needed for what is used here: headings, paragraphs,
 * bullet lists, block quotes, tables, **bold** and `code`. `[Auszufüllen]` is
 * highlighted, so that what is still to do is found at a glance.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function run(text: string, props = ''): string {
  if (!text) return ''
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
}

/** **bold**, `code`, and the marker of what is still to fill in */
function runs(text: string, base = ''): string {
  let out = ''
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue
    if (part.startsWith('**')) out += marked(part.slice(2, -2), `<w:b/>${base}`)
    else if (part.startsWith('`')) out += run(part.slice(1, -1), `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>${base}`)
    else out += marked(part, base)
  }
  return out
}

function marked(text: string, props: string): string {
  return text
    .split(/(\[Auszufüllen\])/)
    .map((t) => (t === '[Auszufüllen]' ? run(t, `${props}<w:highlight w:val="yellow"/>`) : run(t, props)))
    .join('')
}

const para = (content: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`

function table(rows: string[][]): string {
  const columns = Math.max(...rows.map((r) => r.length))
  const width = Math.floor(9000 / columns)
  const border = (n: string) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`
  const head = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders></w:tblPr>`
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>`
  const body = rows
    .map((r, i) => {
      const cells = Array.from({ length: columns }, (_, c) => {
        const props = `<w:tcW w:w="${width}" w:type="dxa"/>${i === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E8E8E8"/>' : ''}`
        return `<w:tc><w:tcPr>${props}</w:tcPr>${para(runs(r[c] ?? '', i === 0 ? '<w:b/>' : ''))}</w:tc>`
      }).join('')
      return `<w:tr>${i === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`
    })
    .join('')
  return `<w:tbl>${head}${grid}${body}</w:tbl>${para('')}`
}

const cellsOf = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/** The body of word/document.xml. */
export function markdownToWordXml(markdown: string): string {
  const out: string[] = []
  const lines = markdown.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^-{3,}$/.test(line.trim()) || /^<!--.*-->$/.test(line.trim())) continue
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      out.push(para(runs(heading[2]), `<w:pStyle w:val="Heading${heading[1].length}"/>`))
      continue
    }
    if (line.startsWith('|')) {
      const rows: string[][] = []
      for (; i < lines.length && lines[i].startsWith('|'); i++) {
        if (!/^\|[\s:|-]+\|$/.test(lines[i].trim())) rows.push(cellsOf(lines[i]))
      }
      i--
      out.push(table(rows))
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      for (; i < lines.length && lines[i].startsWith('>'); i++) quoted.push(lines[i].replace(/^>\s?/, ''))
      i--
      out.push(para(runs(quoted.join(' ')), '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="E0A800"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="FFF8E1"/><w:ind w:left="200"/>'))
      continue
    }
    if (/^- /.test(line)) {
      out.push(para(runs(line.slice(2)), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'))
      continue
    }
    // a paragraph, or a numbered item, over as many lines as it was wrapped
    const text = [line.trim()]
    for (; i + 1 < lines.length && /^\S/.test(lines[i + 1]) && !/^(#|\||>|- |\d+\. |<!--|-{3,}$)/.test(lines[i + 1]); i++) text.push(lines[i + 1].trim())
    for (; i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]); i++) text.push(lines[i + 1].trim())
    out.push(para(runs(text.join(' '))))
  }
  return out.join('')
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const heading = (n: number, size: number) =>
  `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${360 - n * 40}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`

const PARTS: Record<string, string> = {
  '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
  '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  'word/styles.xml': `${XML}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading(1, 36)}${heading(2, 28)}${heading(3, 24)}</w:styles>`,
  'word/numbering.xml': `${XML}<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
}

/** The .docx file of a Markdown document. */
export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const document = `${XML}<w:document ${NS}><w:body>${markdownToWordXml(markdown)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const zip = new archiverLib.ZipArchive({ zlib: { level: 6 } })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.on('data', (c: Buffer) => chunks.push(c))
    zip.on('end', () => resolve(Buffer.concat(chunks)))
    zip.on('error', reject)
  })
  for (const [name, content] of Object.entries(PARTS)) zip.append(content, { name })
  zip.append(document, { name: 'word/document.xml' })
  await zip.finalize()
  return done
}
