import { BadRequestException } from '@nestjs/common'
import { decodeXml, XmlReadError } from '../expense/e-invoice/xml-reader'

/**
 * Tier 883 — the text of an uploaded bank statement, in its own encoding.
 *
 * Both upload routes read the bytes as UTF-8. German banks deliver MT940 in
 * ISO-8859-1 / Windows-1252 as often as not; measured with such a file:
 * the counterparty „BÄCKEREI MÜLLER GMBH“ was stored as „B�CKEREI M�LLER
 * GMBH“, the purpose „Bäckerei“ as „B�ckerei“ — in the books for good, and a
 * name the customer match could not find. A CAMT file declaring
 * ISO-8859-1 was read as UTF-8 as well.
 *
 * XML is read in the encoding it declares (decodeXml, Tier 573); anything
 * else as UTF-8 when it is valid UTF-8, otherwise as Windows-1252.
 */
export function decodeStatement(buffer: Buffer): string {
  const head = buffer.subarray(0, 200).toString('latin1')
  const utf16 = buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
  if (utf16 || /^\s*(?:\xEF\xBB\xBF)?<\?xml/.test(head)) {
    try {
      return decodeXml(buffer)
    } catch (e) {
      if (e instanceof XmlReadError) throw new BadRequestException(e.message)
      throw e
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(buffer)
  }
}
