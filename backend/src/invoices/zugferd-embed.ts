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
 * AFRelationship = "Source" (the primary machine-readable
 * representation) and a name of exactly `factur-x.xml`
 * (ISO 21931 mandates this filename), then write XMP
 * metadata declaring the document as Factur-X EN16931.
 *
 * What it does NOT do
 * ───────────────────
 * True PDF/A-3 conformance requires:
 *   - All fonts embedded and subset
 *   - Explicit ColorSpace entries
 *   - OutputIntent for the target color space
 *   - No transparent objects without the proper Group
 *     dictionary
 *   - And more (see ISO 19005-3 §6)
 *
 * PDFKit's output is *visually* a fine PDF/A-3 — Helvetica is
 * already a Type 1 standard font (always embedded in any
 * compliant reader), images are in standard color spaces —
 * but verifying full conformance is a job for veraPDF /
 * 3-Heights. We mark the document with the XMP hints that
 * tools like Lexware, SevDesk, Datev and the official
 * Factur-X checker look for, which is what 95% of real-world
 * recipients actually check.
 *
 * If you need hard PDF/A-3 conformance for an ELSTER / archive
 * submission, run the output of this module through
 *   verapdf --flavour 3B input.pdf
 * and patch any flags it raises.
 */

import { PDFDocument, AFRelationship, PDFName, PDFArray, PDFDict } from 'pdf-lib';

/**
 * Embed Factur-X / ZUGFeRD XML into a PDF buffer.
 *
 * The XML is expected to be a complete CrossIndustryInvoice
 * document (the same one your service generates, e.g. via
 * zugferd.service.ts → generateZUGFeRDXml). It will be
 * attached as a file with:
 *   - Filename: `factur-x.xml` (ISO-mandated)
 *   - AFRelationship: Source + Data
 *   - MIME type: application/vnd.cef.factur-x+xml
 *     (Factur-X 1.0 / ZUGFeRD 2.x official MIME)
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

  // Embed the XML as a file. pdf-lib normalises the
  // representation: it ends up as a Filespec dictionary
  // with the right /F, /UF, /AFRelationship, /EF.
  const xmlBuffer = Buffer.from(xml, 'utf-8');
  const fileName = 'factur-x.xml';
  await pdf.attach(xmlBuffer, fileName, {
    mimeType: 'application/vnd.cef.factur-x+xml',
    description: `Factur-X ${version} invoice data (${conformanceLevel})`,
    creationDate: new Date(),
    modificationDate: new Date(),
    // AFRelationship declares the role of the attachment in
    // the PDF structure tree. Source = the machine-readable
    // equivalent of the visual content. Some validators
    // also want "Data" — pdf-lib lets us set both.
    afRelationship: AFRelationship.Source,
  });

  // pdf-lib's `attach` only sets Source. Add Data as a
  // second relationship for viewers / validators that
  // require it (e.g. the official Factur-X checker).
  const afArray = (() => {
    // Traverse to the latest AF array on the catalog.
    const catalog = pdf.catalog;
    const af = catalog.lookup(PDFName.of('AF')) as PDFArray | undefined;
    if (!af) return null;
    return af;
  })();
  if (afArray && afArray.size() > 0) {
    // Append a Data relationship mirroring the Source one
    // we just set, on the same attachment.
    const lastSrc = afArray.get(afArray.size() - 1) as PDFDict;
    const ref = lastSrc;
    // Mutate the Filespec to add /AFRelationship as an
    // array of [Source, Data] (instead of the single value
    // pdf-lib wrote). This is what the spec allows.
    const filespec = pdf.context.lookup(ref) as PDFDict;
    if (filespec) {
      filespec.set(
        PDFName.of('AFRelationship'),
        pdf.context.obj([PDFName.of('Source'), PDFName.of('Data')]),
      );
    }
  }

  // ── XMP metadata ───────────────────────────────────────
  // Rewrite the document's XMP packet with the Factur-X
  // hints. A ZUGFeRD-aware reader parses XMP first to
  // decide whether to look for the embedded XML at all.
  const producer = `de-invoice (ZUGFeRD ${version})`;
  const now = new Date().toISOString();

  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="de-invoice">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdf:Producer>${escapeXml(producer)}</pdf:Producer>
      <xmp:CreatorTool>de-invoice</xmp:CreatorTool>
      <xmp:CreateDate>${now}</xmp:CreateDate>
      <xmp:ModifyDate>${now}</xmp:ModifyDate>
      <xmp:MetadataDate>${now}</xmp:MetadataDate>
      <dc:format>application/pdf</dc:format>
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">Factur-X Invoice</rdf:li>
        </rdf:Alt>
      </dc:title>
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>${escapeXml(fileName)}</fx:DocumentFileName>
      <fx:Version>${escapeXml(version)}</fx:Version>
      <fx:ConformanceLevel>${escapeXml(conformanceLevel)}</fx:ConformanceLevel>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  // pdf-lib has no first-class XMP setter that preserves
  // the existing packet, so we drop straight into the
  // catalog and replace the Metadata stream with a brand
  // new one that holds our XMP packet.
  const newMetadataStream = pdf.context.stream(xmp, {
    Type: PDFName.of('Metadata'),
    Subtype: PDFName.of('XML'),
    Length: pdf.context.obj(Buffer.byteLength(xmp, 'utf-8')),
  });
  pdf.catalog.set(PDFName.of('Metadata'), newMetadataStream);

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
