/**
 * Tier 573 — a strict, small XML reader for incoming e-invoices.
 *
 * An incoming invoice is a file from outside. The XML library already in the
 * project (xmlbuilder2) is a builder: measured, it reads `<a><b></a>` and even
 * the word "hello" as documents, and 20 000 nested elements end in a stack
 * overflow after five seconds. So this reads the subset an invoice needs and
 * refuses the rest:
 *
 * - no DOCTYPE at all — no entity definitions, nothing fetched from anywhere
 *   (an invoice has none; XXE and "billion laughs" need one);
 * - tags must match, one root element, nothing but whitespace around it;
 * - at most MAX_DEPTH levels and MAX_NODES elements;
 * - only the five predefined entities and numeric character references.
 *
 * Namespaces are resolved: an element is known by namespace + local name, so
 * `cbc:ID`, `ns3:ID` and a default-namespace `ID` are the same thing.
 */

export interface XmlElement {
  /** local name, without prefix */
  name: string
  /** namespace URI ('' when none) */
  ns: string
  attrs: Record<string, string>
  children: XmlElement[]
  /** the element's own character data (not its descendants'), trimmed */
  text: string
}

export class XmlReadError extends Error {}

const MAX_DEPTH = 64
const MAX_NODES = 400_000
const MAX_ATTRIBUTES = 64
const NAME = /^[A-Za-z_\u00C0-\uFFFF][\w.\-\u00B7\u00C0-\uFFFF]*(?::[A-Za-z_\u00C0-\uFFFF][\w.\-\u00B7\u00C0-\uFFFF]*)?$/

/** The declared encoding decides how the bytes are read (UTF-8 unless said otherwise). */
export function decodeXml(buffer: Buffer): string {
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    return new TextDecoder(buffer[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(buffer).replace(/^\uFEFF/, '')
  }
  const head = buffer.subarray(0, 200).toString('latin1')
  const declared = /^\s*(?:\xEF\xBB\xBF)?<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1]?.toLowerCase()
  let label = 'utf-8'
  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    if (/^(iso-8859-1|iso8859-1|latin1|windows-1252|cp1252|iso-8859-15|us-ascii|ascii)$/.test(declared)) {
      label = declared === 'iso-8859-15' ? 'iso-8859-15' : declared.includes('ascii') ? 'utf-8' : 'windows-1252'
    } else {
      throw new XmlReadError(`Die Zeichenkodierung „${declared}“ wird nicht unterstützt.`)
    }
  }
  try {
    return new TextDecoder(label, { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    throw new XmlReadError('Die Datei ist nicht in der angegebenen Zeichenkodierung gespeichert.')
  }
}

function unescape(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      const ok = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
      if (!ok) throw new XmlReadError('Ungültiger Zeichenverweis in der XML-Datei.')
      return String.fromCodePoint(code)
    }
    switch (ref) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      default: throw new XmlReadError(`Unbekannte Entität „&${ref};“ in der XML-Datei.`)
    }
  })
}

/** Parse the document and return its root element. Throws XmlReadError. */
export function readXml(xml: string): XmlElement {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new XmlReadError('Die XML-Datei enthält eine DOCTYPE-Deklaration; das ist für eine E-Rechnung nicht zulässig.')
  }
  const len = xml.length
  let i = 0
  let nodes = 0
  let root: XmlElement | null = null
  // open elements, each with the namespace bindings in force inside it
  const stack: { el: XmlElement; qname: string; bindings: Record<string, string>; text: string[] }[] = []
  const bad = (what: string): never => {
    throw new XmlReadError(`Die XML-Datei ist nicht wohlgeformt (${what}).`)
  }

  while (i < len) {
    const lt = xml.indexOf('<', i)
    const chunk = lt === -1 ? xml.slice(i) : xml.slice(i, lt)
    if (chunk) {
      if (stack.length) stack[stack.length - 1].text.push(unescape(chunk))
      else if (chunk.trim()) bad('Text außerhalb des Wurzelelements')
    }
    if (lt === -1) break
    i = lt
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      if (end === -1) bad('Kommentar nicht geschlossen')
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      if (end === -1) bad('CDATA nicht geschlossen')
      if (!stack.length) bad('CDATA außerhalb des Wurzelelements')
      stack[stack.length - 1].text.push(xml.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      if (end === -1) bad('Verarbeitungsanweisung nicht geschlossen')
      i = end + 2
      continue
    }
    if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i + 2)
      if (end === -1) bad('schließendes Tag nicht beendet')
      const qname = xml.slice(i + 2, end).trim()
      const open = stack.pop()
      if (!open || open.qname !== qname) bad(`</${qname.slice(0, 60)}> passt nicht zum geöffneten Element`)
      open!.el.text = open!.text.join('').trim()
      i = end + 1
      continue
    }
    // a start tag: find its end, respecting quoted attribute values
    let j = i + 1
    let quote = ''
    while (j < len) {
      const c = xml[j]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      else if (c === '<') bad('„<“ in einem Tag')
      j++
    }
    if (j >= len) bad('Tag nicht beendet')
    let body = xml.slice(i + 1, j)
    const selfClosing = body.endsWith('/')
    if (selfClosing) body = body.slice(0, -1)
    const nameEnd = body.search(/\s/)
    const qname = nameEnd === -1 ? body : body.slice(0, nameEnd)
    if (!NAME.test(qname)) bad('ungültiger Elementname')
    const attrs: Record<string, string> = {}
    const rawAttrs: [string, string][] = []
    if (nameEnd !== -1) {
      const rest = body.slice(nameEnd)
      const re = /\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')|\s+|(\S)/gy
      let m: RegExpExecArray | null
      re.lastIndex = 0
      while (re.lastIndex < rest.length && (m = re.exec(rest))) {
        if (m[4] !== undefined) bad('ungültiges Attribut')
        if (m[1] === undefined) continue
        if (!NAME.test(m[1])) bad('ungültiger Attributname')
        const value = m[2] ?? m[3] ?? ''
        if (value.includes('<')) bad('„<“ in einem Attributwert')
        if (rawAttrs.some(([k]) => k === m![1])) bad('Attribut doppelt')
        // the duplicate check above is quadratic; an invoice element has a handful
        if (rawAttrs.length >= MAX_ATTRIBUTES) bad('zu viele Attribute an einem Element')
        rawAttrs.push([m[1], unescape(value)])
      }
      if (re.lastIndex < rest.length) bad('ungültiges Attribut')
    }
    const parent = stack[stack.length - 1]
    let bindings = parent ? parent.bindings : { xml: 'http://www.w3.org/XML/1998/namespace' }
    for (const [k, v] of rawAttrs) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) {
        if (bindings === (parent ? parent.bindings : bindings)) bindings = { ...bindings }
        bindings[k === 'xmlns' ? '' : k.slice(6)] = v
      } else {
        // attributes are kept by local name; an invoice has no two that differ only by prefix
        attrs[k.includes(':') ? k.slice(k.indexOf(':') + 1) : k] = v
      }
    }
    const colon = qname.indexOf(':')
    const prefix = colon === -1 ? '' : qname.slice(0, colon)
    if (prefix && bindings[prefix] === undefined) bad(`Namensraum-Präfix „${prefix}“ ist nicht deklariert`)
    const el: XmlElement = { name: colon === -1 ? qname : qname.slice(colon + 1), ns: bindings[prefix] ?? '', attrs, children: [], text: '' }
    if (++nodes > MAX_NODES) throw new XmlReadError('Die XML-Datei hat zu viele Elemente.')
    if (parent) parent.el.children.push(el)
    else if (root) bad('mehr als ein Wurzelelement')
    else root = el
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlReadError('Die XML-Datei ist zu tief verschachtelt.')
      stack.push({ el, qname, bindings, text: [] })
    }
    i = j + 1
  }
  if (stack.length) bad(`<${stack[stack.length - 1].qname.slice(0, 60)}> wird nicht geschlossen`)
  if (!root) bad('kein Wurzelelement')
  return root!
}

/** first child with that local name */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name)
}

/** all children with that local name */
export function children(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : []
}

/** descend along local names; undefined as soon as one is missing */
export function at(el: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
  let cur = el
  for (const p of path) {
    cur = child(cur, p)
    if (!cur) return undefined
  }
  return cur
}

/** text at a path, or null when missing or empty */
export function textAt(el: XmlElement | undefined, ...path: string[]): string | null {
  const t = at(el, ...path)?.text
  return t ? t : null
}
