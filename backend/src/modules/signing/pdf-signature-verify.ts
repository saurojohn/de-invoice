/**
 * Tier 583 — verifying a PDF signature for real.
 *
 * `verifyPdf` used to call a signature valid when its container held a
 * 32-byte messageDigest attribute. It compared that digest with nothing and
 * checked no signature. Measured on a PDF signed by this application:
 *   - the visible amount changed after signing        → "valid"
 *   - the signature value itself overwritten          → "valid"
 *   - bytes appended after the signed range           → "valid"
 * and a PDF carrying any container with any certificate named after the
 * company would have been "valid, signed by <company>".
 *
 * What is checked now, per signature in the file:
 *   1. the ByteRange is what a signature's must be — from byte 0, the gap is
 *      exactly the hex string of /Contents, and (for the last signature) it
 *      reaches the end of the file: nothing was added afterwards;
 *   2. the hash of those bytes is the messageDigest in the signed attributes;
 *   3. the signature over the signed attributes verifies with the public key
 *      of a certificate in the container (Node's crypto — not node-forge,
 *      whose RSA verification has an open advisory).
 *
 * What is NOT established here is who the certificate belongs to: the
 * certificates are self-signed. The caller compares the fingerprint with the
 * certificates this installation issued (`knownSigner`).
 */
import { X509Certificate, createHash, verify as cryptoVerify } from 'crypto'

export interface PdfSignatureCheck {
  valid: boolean
  /** why not, in German, for the page */
  reason: string | null
  signedBy: string | null
  signedAt: string | null
  /** SHA-256 of the certificate, AA:BB:… */
  certFingerprint: string | null
  certValidFrom: string | null
  certValidUntil: string | null
  /** the signed range reaches the end of the file */
  coversWholeDocument: boolean
}

// ---- a minimal DER reader: enough to walk a CMS SignedData ------------------

interface Tlv {
  tag: number
  /** offset of the tag byte */
  start: number
  /** offset of the first content byte */
  body: number
  /** offset after the last content byte */
  end: number
}

function tlv(buf: Buffer, at: number, limit: number): Tlv {
  if (at + 2 > limit) throw new Error('DER: abgeschnitten')
  const tag = buf[at]
  if ((tag & 0x1f) === 0x1f) throw new Error('DER: mehrbytiges Tag')
  let len = buf[at + 1]
  let body = at + 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4 || body + n > limit) throw new Error('DER: unbestimmte oder zu große Länge')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[body + i]
    body += n
  }
  if (body + len > limit) throw new Error('DER: Länge über das Ende hinaus')
  return { tag, start: at, body, end: body + len }
}

function childrenOf(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = []
  let at = parent.body
  while (at < parent.end) {
    const t = tlv(buf, at, parent.end)
    out.push(t)
    at = t.end
    if (out.length > 10_000) throw new Error('DER: zu viele Elemente')
  }
  return out
}

function oid(buf: Buffer, t: Tlv): string {
  if (t.tag !== 0x06) throw new Error('DER: OID erwartet')
  const bytes = buf.subarray(t.body, t.end)
  const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40]
  let v = 0
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i] & 0x7f)
    if (!(bytes[i] & 0x80)) {
      parts.push(v)
      v = 0
    }
  }
  return parts.join('.')
}

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2'
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5'
const DIGESTS: Record<string, string> = {
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
}

interface SignerInfo {
  digest: string
  /** the SignedAttributes as they are hashed: with the SET tag */
  signedAttrs: Buffer | null
  messageDigest: Buffer | null
  signingTime: string | null
  signature: Buffer
}

function parseCms(cms: Buffer): { certificates: Buffer[]; signer: SignerInfo } {
  const contentInfo = tlv(cms, 0, cms.length)
  if (contentInfo.tag !== 0x30) throw new Error('kein PKCS#7-Container')
  const [type, wrapped] = childrenOf(cms, contentInfo)
  if (!type || !wrapped || oid(cms, type) !== OID_SIGNED_DATA) throw new Error('kein SignedData-Container')
  const signedData = tlv(cms, wrapped.body, wrapped.end)
  const parts = childrenOf(cms, signedData)
  // version, digestAlgorithms, encapContentInfo, [0] certificates?, [1] crls?, signerInfos
  const certificates: Buffer[] = []
  const certSet = parts.find((p) => p.tag === 0xa0)
  if (certSet) for (const c of childrenOf(cms, certSet)) if (c.tag === 0x30) certificates.push(cms.subarray(c.start, c.end))
  const signerInfos = parts[parts.length - 1]
  if (!signerInfos || signerInfos.tag !== 0x31) throw new Error('keine SignerInfo')
  const infos = childrenOf(cms, signerInfos)
  if (infos.length !== 1) throw new Error(`${infos.length} Unterzeichner in einem Container (erwartet: einer)`)
  const si = childrenOf(cms, infos[0])
  // version, sid, digestAlgorithm, [0] signedAttrs?, signatureAlgorithm, signature, [1] unsignedAttrs?
  if (si.length < 5) throw new Error('SignerInfo unvollständig')
  const digestOid = oid(cms, childrenOf(cms, si[2])[0])
  const digest = DIGESTS[digestOid]
  if (!digest) throw new Error(`Hash-Verfahren ${digestOid} wird nicht anerkannt (SHA-256 / 384 / 512)`)
  const attrsAt = si.findIndex((p) => p.tag === 0xa0)
  const signatureNode = si[(attrsAt === -1 ? 2 : attrsAt) + 2]
  if (!signatureNode || signatureNode.tag !== 0x04) throw new Error('Signaturwert fehlt')
  let signedAttrs: Buffer | null = null
  let messageDigest: Buffer | null = null
  let signingTime: string | null = null
  if (attrsAt !== -1) {
    const a = si[attrsAt]
    signedAttrs = Buffer.from(cms.subarray(a.start, a.end))
    signedAttrs[0] = 0x31 // hashed as a SET OF, not as the [0] it is stored as (RFC 5652 §5.4)
    for (const attr of childrenOf(cms, a)) {
      const [attrType, values] = childrenOf(cms, attr)
      if (!attrType || !values) continue
      const value = childrenOf(cms, values)[0]
      if (!value) continue
      const id = oid(cms, attrType)
      if (id === OID_MESSAGE_DIGEST && value.tag === 0x04) messageDigest = cms.subarray(value.body, value.end)
      if (id === OID_SIGNING_TIME) signingTime = derTime(cms.subarray(value.body, value.end).toString('latin1'), value.tag)
    }
  }
  return { certificates, signer: { digest, signedAttrs, messageDigest, signingTime, signature: cms.subarray(signatureNode.body, signatureNode.end) } }
}

function derTime(s: string, tag: number): string | null {
  // UTCTime YYMMDDhhmmssZ (0x17) or GeneralizedTime YYYYMMDDhhmmssZ (0x18)
  const m = tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
  if (!m) return null
  const year = tag === 0x17 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1])
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// ---- the PDF side -------------------------------------------------------------

/** every /ByteRange [a b c d] in the file, in file order */
function byteRanges(pdf: Buffer): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  const text = pdf.toString('latin1')
  const re = /\/ByteRange\s*\[\s*(\d{1,12})\s+(\d{1,12})\s+(\d{1,12})\s+(\d{1,12})\s*\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && out.length < 32) out.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
  return out
}

const failed = (reason: string, partial: Partial<PdfSignatureCheck> = {}): PdfSignatureCheck => ({
  valid: false,
  reason,
  signedBy: null,
  signedAt: null,
  certFingerprint: null,
  certValidFrom: null,
  certValidUntil: null,
  coversWholeDocument: false,
  ...partial,
})

function checkOne(pdf: Buffer, [a, b, c, d]: [number, number, number, number]): PdfSignatureCheck {
  // 1. the shape of the range
  if (a !== 0 || b <= 0 || c <= b || d < 0 || c + d > pdf.length) return failed('Der signierte Bereich (ByteRange) ist ungültig.')
  const coversWholeDocument = c + d === pdf.length
  if (pdf[b] !== 0x3c /* < */ || pdf[c - 1] !== 0x3e /* > */) {
    return failed('Der signierte Bereich lässt mehr aus als die Signatur selbst.', { coversWholeDocument })
  }
  const hex = pdf.subarray(b + 1, c - 1).toString('latin1')
  if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2 !== 0) {
    return failed('Der signierte Bereich lässt mehr aus als die Signatur selbst.', { coversWholeDocument })
  }
  const container = Buffer.from(hex, 'hex')
  if (container.length < 16 || container[0] !== 0x30) return failed('PKCS#7-Container nicht gefunden.', { coversWholeDocument })

  // 2. the container (its DER length says where it ends; the rest is padding)
  let parsed: ReturnType<typeof parseCms>
  try {
    const outer = tlv(container, 0, container.length)
    parsed = parseCms(container.subarray(0, outer.end))
  } catch (e) {
    return failed(`Die Signatur ist nicht lesbar: ${(e as Error).message}.`, { coversWholeDocument })
  }
  const { certificates, signer } = parsed
  if (certificates.length === 0) return failed('Die Signatur enthält kein Zertifikat.', { coversWholeDocument })

  // 3. the document's hash is the one that was signed
  const signedBytes = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)])
  const documentDigest = createHash(signer.digest).update(signedBytes).digest()

  // 4. the signature verifies with one of the certificates
  let signerCert: X509Certificate | null = null
  for (const der of certificates.slice(0, 16)) {
    let cert: X509Certificate
    try {
      cert = new X509Certificate(der)
    } catch {
      continue
    }
    try {
      const ok = signer.signedAttrs
        ? cryptoVerify(signer.digest, signer.signedAttrs, cert.publicKey, signer.signature)
        : cryptoVerify(signer.digest, signedBytes, cert.publicKey, signer.signature)
      if (ok) {
        signerCert = cert
        break
      }
    } catch {
      // a key type or padding this cannot check — not a valid signature for us
    }
  }
  const first = (() => {
    try {
      return new X509Certificate(certificates[0])
    } catch {
      return null
    }
  })()
  const about = (cert: X509Certificate | null): Partial<PdfSignatureCheck> =>
    cert
      ? {
          signedBy: /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1] ?? null,
          certFingerprint: cert.fingerprint256,
          certValidFrom: new Date(cert.validFrom).toISOString(),
          certValidUntil: new Date(cert.validTo).toISOString(),
        }
      : {}
  if (!signerCert) {
    return failed('Die Signatur passt nicht zum enthaltenen Zertifikat — sie ist gefälscht oder beschädigt.', { coversWholeDocument, ...about(first) })
  }
  const info = { coversWholeDocument, signedAt: signer.signingTime, ...about(signerCert) }
  if (signer.signedAttrs) {
    if (!signer.messageDigest) return failed('Die Signatur nennt keinen Hash des Dokuments.', info)
    if (!signer.messageDigest.equals(documentDigest)) {
      return failed('Das Dokument wurde nach dem Signieren verändert.', info)
    }
  }
  return { valid: true, reason: null, signedBy: null, certFingerprint: null, certValidFrom: null, certValidUntil: null, ...info }
}

/**
 * Check every signature in the PDF. `valid` only when there is at least one,
 * each of them verifies, and the last one covers the file to its end.
 */
export function checkPdfSignatures(pdf: Buffer): { valid: boolean; reason: string | null; signatures: PdfSignatureCheck[] } {
  const ranges = byteRanges(pdf)
  if (ranges.length === 0) return { valid: false, reason: 'PDF enthält keine Signatur', signatures: [] }
  const signatures = ranges.map((r) => checkOne(pdf, r))
  const bad = signatures.find((s) => !s.valid)
  if (bad) return { valid: false, reason: bad.reason, signatures }
  if (!signatures[signatures.length - 1].coversWholeDocument) {
    return { valid: false, reason: 'Nach der letzten Signatur wurde dem Dokument etwas hinzugefügt.', signatures }
  }
  return { valid: true, reason: null, signatures }
}
