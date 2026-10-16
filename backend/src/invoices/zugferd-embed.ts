/**
 * ZUGFeRD / Factur-X PDF/A-3 attachment embedder.
 *
 * Why this exists
 * ───────────────
 * ZUGFeRD 2.x = Factur-X = a PDF/A-3 document with an embedded
 * XML invoice (the so-called "hybrid" format: humans read the
 * PDF, machines read the XML).
 *
 * PDFKit (the backend's PDF generator) produces a *plain* PDF,
 * not a PDF/A-3, and has no API to attach arbitrary files.
 * pdf-lib on the other hand can load an existing PDF, attach
 * files via its `attach` method, and rewrite XMP metadata.
 *
 * This module is the bridge: take the PDFKit buffer, load it
 * with pdf-lib, attach the Factur-X XML as a file with
 * AFRelationship = "Alternative" (Factur-X 1.0 for EN 16931:
 * the XML is an equivalent of the visual invoice) and a name of
 * exactly `factur-x.xml` (Factur-X mandates it), then write XMP
 * metadata declaring the document as Factur-X EN16931.
 *
 * PDF/A-3 (Tier 693)
 * ─────────────────
 * The document is a PDF/A-3B, checked with Mustang 2.26 (the ZUGFeRD
 * reference validator, veraPDF inside) — spec 417, with MUSTANG_JAR:
 *   - fonts embedded (pdf-fonts.ts: Liberation in place of the standard 14)
 *   - an sRGB OutputIntent (assets/icc/sRGB-v2-micro.icc)
 *   - the XMP an indirect, unfiltered stream with the Factur-X extension
 *     schema, Info and XMP alike
 *   - the XML as factur-x.xml, text/xml, /AFRelationship /Alternative
 * Until Tier 693 the XMP claimed PDF/A-3B and none of this held; Mustang
 * could not even find the XML.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument, AFRelationship, PDFName, PDFString } from 'pdf-lib';

/**
 * Embed Factur-X / ZUGFeRD XML into a PDF buffer.
 *
 * The XML is expected to be a complete CrossIndustryInvoice
 * document (the same one your service generates, e.g. via
 * zugferd.service.ts → generateZUGFeRDXml). It will be
 * attached as a file with:
 *   - Filename: `factur-x.xml` (ISO-mandated)
 *   - AFRelationship: Alternative (EN 16931 and above), Data (lower profiles)
 *   - MIME type: text/xml (Factur-X 1.0 / ZUGFeRD 2.x)
 *
 * XMP metadata is also rewritten with the Factur-X
 * conformance hints. The reader then knows the file is a
 * Factur-X document without having to crack open the
 * attachment.
 *
 * @param pdfBuffer  PDF bytes from PDFKit
 * @param xml        The Factur-X / ZUGFeRD XML
 * @param version    ZUGFeRD version (1.0 / 2.0 / 2.1) — only
 *                   affects the XMP description, the embedded
 *                   XML is identical across versions
 * @param conformanceLevel  EN16931 (standard) / BASIC / EXTENDED
 * @returns New PDF buffer with the XML attached
 */
export async function embedFacturX(
  pdfBuffer: Buffer,
  xml: string,
  version: '1.0' | '2.0' | '2.1' = '2.1',
  conformanceLevel: 'BASIC' | 'EN16931' | 'EXTENDED' = 'EN16931',
): Promise<Buffer> {
  const pdf = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const level = xmpConformanceLevel(conformanceLevel);

  // Tier 693: measured with Mustang (veraPDF inside), the PDF was no PDF/A-3
  // and the validator could not even find the XML: the XMP stream sat inline
  // in the catalog (a stream must be an indirect object), the attachment was
  // "application/vnd.cef.factur-x+xml" (Factur-X: text/xml), /AFRelationship
  // was an array [Source Data] (a single name: Alternative for EN 16931 and
  // above, Data for the lower profiles), the XMP named Factur-X properties
  // without their extension schema, there was no OutputIntent (every
  // DeviceRGB / DeviceGray use failed), and the fonts were not embedded
  // (pdf-fonts.ts).
  const xmlBuffer = Buffer.from(xml, 'utf-8');
  const fileName = 'factur-x.xml';
  const now = new Date(Math.floor(Date.now() / 1000) * 1000); // whole seconds: Info and XMP alike
  const relationship = level === 'MINIMUM' || level === 'BASIC WL' || level === 'BASIC'
    ? AFRelationship.Data : AFRelationship.Alternative;
  await pdf.attach(xmlBuffer, fileName, {
    mimeType: 'text/xml',
    description: `Factur-X ${level} invoice data`,
    creationDate: now,
    modificationDate: now,
    afRelationship: relationship,
  });

  // ── OutputIntent: sRGB (ISO 19005-3 6.2.4.3, 6.2.10) ───
  const icc = fs.readFileSync(ICC_PROFILE);
  const iccRef = pdf.context.register(pdf.context.flateStream(icc, { N: 3 }));
  const outputIntent = pdf.context.register(pdf.context.obj({
    Type: PDFName.of('OutputIntent'),
    S: PDFName.of('GTS_PDFA1'),
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  }));
  pdf.catalog.set(PDFName.of('OutputIntents'), pdf.context.obj([outputIntent]));

  // ── document information, the same in Info and in XMP (6.6.3) ──
  const producer = `de-invoice (ZUGFeRD ${version})`;
  const header = /<rsm:ExchangedDocument>\s*<ram:ID>([^<]*)<\/ram:ID>\s*<ram:TypeCode>(\d+)</.exec(xml);
  const kind = header?.[2] === '381' ? 'Gutschrift' : 'Rechnung';
  const title = header ? `${kind} ${unescapeXml(header[1])}` : kind;
  pdf.setTitle(title);
  pdf.setProducer(producer);
  pdf.setCreator('de-invoice');
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>de-invoice</rdf:li></rdf:Seq></dc:creator>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>${escapeXml(producer)}</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>de-invoice</xmp:CreatorTool>
      <xmp:CreateDate>${stamp}</xmp:CreateDate>
      <xmp:ModifyDate>${stamp}</xmp:ModifyDate>
      <xmp:MetadataDate>${stamp}</xmp:MetadataDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>${escapeXml(fileName)}</fx:DocumentFileName>
      <fx:Version>${FACTUR_X_XMP_VERSION}</fx:Version>
      <fx:ConformanceLevel>${escapeXml(level)}</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
${FACTUR_X_PROPERTIES.map(([name, description]) => `                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>${name}</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>${description}</pdfaProperty:description>
                </rdf:li>`).join('\n')}
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  // An indirect, unfiltered stream (6.6.2.1); it was written inline into the catalog
  const metadata = pdf.context.register(pdf.context.stream(Buffer.from(xmp, 'utf-8'), {
    Type: PDFName.of('Metadata'),
    Subtype: PDFName.of('XML'),
  }));
  pdf.catalog.set(PDFName.of('Metadata'), metadata);

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** The four properties of the Factur-X XMP schema, as its extension schema declares them. */
const FACTUR_X_PROPERTIES: [string, string][] = [
  ['DocumentFileName', 'The name of the embedded XML document'],
  ['DocumentType', 'The type of the hybrid document in capital letters, e.g. INVOICE or ORDER'],
  ['Version', 'The actual version of the standard applying to the embedded XML document'],
  ['ConformanceLevel', 'The conformance level of the embedded XML document'],
];

// backend/src/invoices → backend/assets, and the same from backend/dist/invoices
const ICC_PROFILE = path.resolve(__dirname, '..', '..', 'assets', 'icc', 'sRGB-v2-micro.icc');

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Tier 414: the Factur-X XMP schema (urn:factur-x:pdfa:CrossIndustryDocument:
 * invoice:1p0#) has its own values, not the ZUGFeRD release number: the
 * version of the XMP schema is "1.0" for ZUGFeRD 2.x / Factur-X 1.0, and the
 * level is one of MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED, XRECHNUNG —
 * "EN 16931" with a space. This wrote "2.1" and "EN16931".
 */
const FACTUR_X_XMP_VERSION = '1.0';

function xmpConformanceLevel(level: string): string {
  const key = level.replace(/[\s_-]/g, '').toUpperCase();
  const map: Record<string, string> = {
    MINIMUM: 'MINIMUM',
    BASICWL: 'BASIC WL',
    BASIC: 'BASIC',
    EN16931: 'EN 16931',
    COMFORT: 'EN 16931',
    EXTENDED: 'EXTENDED',
    XRECHNUNG: 'XRECHNUNG',
  };
  return map[key] ?? level;
}
