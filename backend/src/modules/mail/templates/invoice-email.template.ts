/**
 * Email template for invoice send-out.
 *
 * Three locales (de / en / zh) — placeholders are
 * the same as the ones in messages/*.json so the
 * frontend can preview exactly what the backend
 * will send. The backend is the authoritative
 * renderer: it reads this file directly, substitutes
 * the variables, and passes the result to
 * MailService.send.
 *
 * Why server-side rendering and not letting the
 * frontend submit the rendered text? Because the
 * server is the one actually sending the email, and
 * we want a single source of truth. If the frontend
 * could send arbitrary text, a malicious user could
 * inject anything as the "invoice subject". The
 * server template is sanitised, the customer's
 * name is HTML-escaped at the substitution step.
 *
 * Placeholders (all substituted at send time):
 *   {invoiceNumber}  e.g. "INV-2026-000058"
 *   {customerName}   e.g. "CSV Import Co A" (HTML-escaped)
 *   {amount}         e.g. "119,00 €" / "119.00 €" / "119.00"
 *   {dueDate}        e.g. "13.07.2026" / "07/13/2026" / "2026-07-13"
 *   {companyName}    e.g. "SH Leder GmbH"
 *   {salutation}     locale-aware greeting
 *
 * The `salutation` placeholder is special: it
 * gets prepended to {customerName} in the body
 * and is one of:
 *   - {salutationFormal}: "Sehr geehrte/r Herr/Frau" / "Dear Mr/Ms" / "尊敬的"
 *   - {salutationNeutral}: "Sehr geehrte/r" / "Dear" / "尊敬的"
 *   - "" (empty, no greeting) if `customerName` is
 *     blank so we don't get "Sehr geehrte/r ,"
 *
 * Amount / dueDate are formatted with the
 * language's Intl.NumberFormat / Intl.DateTimeFormat
 * (de-DE / en-US / zh-CN).
 */
export type EmailLang = 'de' | 'en' | 'zh';

export interface InvoiceEmailVars {
  invoiceNumber: string;
  customerName: string;
  amount: string;       // pre-formatted with the locale
  dueDate: string;      // pre-formatted with the locale
  companyName: string;
  salutation: string;   // locale + gender (or empty)
}

export interface RenderedInvoiceEmail {
  subject: string;
  text: string;
}

const TEMPLATES: Record<EmailLang, { subject: string; body: string }> = {
  de: {
    subject: 'Rechnung {invoiceNumber} von {companyName}',
    body:
      '{salutation} {customerName},\n\n' +
      'anbei erhalten Sie die Rechnung {invoiceNumber} über {amount}.\n\n' +
      'Bitte begleichen Sie den Betrag bis zum {dueDate}.\n\n' +
      'Die Rechnung finden Sie im Anhang als PDF.\n\n' +
      'Mit freundlichen Grüßen\n{companyName}',
  },
  en: {
    subject: 'Invoice {invoiceNumber} from {companyName}',
    body:
      '{salutation} {customerName},\n\n' +
      'Please find attached invoice {invoiceNumber} for {amount}.\n\n' +
      'The amount is due by {dueDate}.\n\n' +
      'The invoice is attached as a PDF.\n\n' +
      'Kind regards,\n{companyName}',
  },
  zh: {
    subject: '发票 {invoiceNumber} 来自 {companyName}',
    body:
      '{salutation}{customerName}:\n\n' +
      '随信附上发票 {invoiceNumber},金额 {amount}。\n\n' +
      '请于 {dueDate} 前支付。\n\n' +
      '发票以 PDF 格式附在邮件中。\n\n' +
      '此致\n敬礼\n\n' +
      '{companyName}',
  },
};

// Tier 610: a quote asks for an order, not for money; a delivery note
// asks for nothing.
const DOCUMENT_TEMPLATES: Record<string, Record<EmailLang, { subject: string; body: string }>> = {
  // Tier 689: a credit note, a receipt and a proforma had none — they went out
  // as "anbei erhalten Sie die Rechnung CN-… über -119,00 €. Bitte begleichen
  // Sie den Betrag" (a receipt: pay what is paid).
  CN: {
    de: {
      subject: 'Gutschrift {invoiceNumber} von {companyName}',
      body:
        '{salutation} {customerName},\n' +
        '\n' +
        'anbei erhalten Sie unsere Gutschrift {invoiceNumber} über {amount}.\n' +
        '\n' +
        'Sie finden sie im Anhang als PDF.\n' +
        '\n' +
        'Mit freundlichen Grüßen\n' +
        '{companyName}',
    },
    en: {
      subject: 'Credit note {invoiceNumber} from {companyName}',
      body:
        '{salutation} {customerName},\n' +
        '\n' +
        'Please find attached our credit note {invoiceNumber} for {amount}.\n' +
        '\n' +
        'It is attached as a PDF.\n' +
        '\n' +
        'Kind regards,\n' +
        '{companyName}',
    },
    zh: {
      subject: '贷项通知单 {invoiceNumber} 来自 {companyName}',
      body:
        '{salutation}{customerName}:\n' +
        '\n' +
        '随信附上我方贷项通知单 {invoiceNumber},金额 {amount}。\n' +
        '\n' +
        '贷项通知单以 PDF 格式附在邮件中。\n' +
        '\n' +
        '此致\n' +
        '敬礼\n' +
        '\n' +
        '{companyName}',
    },
  },
  RCV: {
    de: {
      subject: 'Quittung {invoiceNumber} von {companyName}',
      body:
        '{salutation} {customerName},\n' +
        '\n' +
        'anbei erhalten Sie die Quittung {invoiceNumber} über {amount}. Der Betrag ist bezahlt — vielen Dank.\n' +
        '\n' +
        'Sie finden sie im Anhang als PDF.\n' +
        '\n' +
        'Mit freundlichen Grüßen\n' +
        '{companyName}',
    },
    en: {
      subject: 'Receipt {invoiceNumber} from {companyName}',
      body:
        '{salutation} {customerName},\n' +
        '\n' +
        'Please find attached receipt {invoiceNumber} for {amount}. The amount has been paid — thank you.\n' +
        '\n' +
        'It is attached as a PDF.\n' +
        '\n' +
        'Kind regards,\n' +
        '{companyName}',
    },
    zh: {
      subject: '收据 {invoiceNumber} 来自 {companyName}',
      body:
        '{salutation}{customerName}:\n' +
        '\n' +
        '随信附上收据 {invoiceNumber},金额 {amount}。该款项已付清,谢谢。\n' +
        '\n' +
        '收据以 PDF 格式附在邮件中。\n' +
        '\n' +
        '此致\n' +
        '敬礼\n' +
        '\n' +
        '{companyName}',
    },
  },
  PI: {
    de: {
      subject: 'Proforma-Rechnung {invoiceNumber} von {companyName}',
      body:
        '{salutation} {customerName},\n' +
        '\n' +
        'anbei erhalten Sie die Proforma-Rechnung {invoiceNumber} über {amount}.\n' +
        '\n' +
        'Bitte überweisen Sie den Betrag bis zum {dueDate}.\n' +
        '\n' +
        'Sie finden sie im Anhang als PDF.\n' +
        '\n' +
        'Mit freundlichen Grüßen\n' +
        '{companyName}',
    },
    en: {
      subject: 'Proforma invoice {invoiceNumber} from {companyName}',
      body:
        '{salutation} {customerName},\n' +
        '\n' +
        'Please find attached proforma invoice {invoiceNumber} for {amount}.\n' +
        '\n' +
        'Please transfer the amount by {dueDate}.\n' +
        '\n' +
        'It is attached as a PDF.\n' +
        '\n' +
        'Kind regards,\n' +
        '{companyName}',
    },
    zh: {
      subject: '形式发票 {invoiceNumber} 来自 {companyName}',
      body:
        '{salutation}{customerName}:\n' +
        '\n' +
        '随信附上形式发票 {invoiceNumber},金额 {amount}。\n' +
        '\n' +
        '请于 {dueDate} 前转账。\n' +
        '\n' +
        '形式发票以 PDF 格式附在邮件中。\n' +
        '\n' +
        '此致\n' +
        '敬礼\n' +
        '\n' +
        '{companyName}',
    },
  },
  QU: {
    de: {
      subject: 'Angebot {invoiceNumber} von {companyName}',
      body:
        '{salutation} {customerName},\n\n' +
        'anbei erhalten Sie unser Angebot {invoiceNumber} über {amount}.\n\n' +
        'Das Angebot ist gültig bis zum {dueDate}.\n\n' +
        'Sie finden es im Anhang als PDF. Wir freuen uns auf Ihren Auftrag.\n\n' +
        'Mit freundlichen Grüßen\n{companyName}',
    },
    en: {
      subject: 'Quote {invoiceNumber} from {companyName}',
      body:
        '{salutation} {customerName},\n\n' +
        'Please find attached our quote {invoiceNumber} for {amount}.\n\n' +
        'The quote is valid until {dueDate}.\n\n' +
        'It is attached as a PDF. We look forward to your order.\n\n' +
        'Kind regards,\n{companyName}',
    },
    zh: {
      subject: '报价单 {invoiceNumber} 来自 {companyName}',
      body:
        '{salutation}{customerName}:\n\n' +
        '随信附上我方报价单 {invoiceNumber},金额 {amount}。\n\n' +
        '报价有效期至 {dueDate}。\n\n' +
        '报价单以 PDF 格式附在邮件中,期待您的订单。\n\n' +
        '此致\n敬礼\n\n' +
        '{companyName}',
    },
  },
  OC: {
    de: {
      subject: 'Auftragsbestätigung {invoiceNumber} von {companyName}',
      body:
        '{salutation} {customerName},\n\n' +
        'vielen Dank für Ihren Auftrag. Anbei erhalten Sie unsere Auftragsbestätigung {invoiceNumber} über {amount}.\n\n' +
        'Sie finden sie im Anhang als PDF. Bitte prüfen Sie die Angaben und melden Sie sich, falls etwas nicht stimmt.\n\n' +
        'Mit freundlichen Grüßen\n{companyName}',
    },
    en: {
      subject: 'Order confirmation {invoiceNumber} from {companyName}',
      body:
        '{salutation} {customerName},\n\n' +
        'Thank you for your order. Please find attached our order confirmation {invoiceNumber} for {amount}.\n\n' +
        'It is attached as a PDF. Please check the details and let us know if anything is not right.\n\n' +
        'Kind regards,\n{companyName}',
    },
    zh: {
      subject: '订单确认 {invoiceNumber} 来自 {companyName}',
      body:
        '{salutation}{customerName}:\n\n' +
        '感谢您的订单。随信附上我方订单确认 {invoiceNumber},金额 {amount}。\n\n' +
        '订单确认以 PDF 格式附在邮件中,请核对内容,如有不符请与我们联系。\n\n' +
        '此致\n敬礼\n\n' +
        '{companyName}',
    },
  },
  DN: {
    de: {
      subject: 'Lieferschein {invoiceNumber} von {companyName}',
      body:
        '{salutation} {customerName},\n\n' +
        'anbei erhalten Sie den Lieferschein {invoiceNumber} zu Ihrer Lieferung.\n\n' +
        'Sie finden ihn im Anhang als PDF.\n\n' +
        'Mit freundlichen Grüßen\n{companyName}',
    },
    en: {
      subject: 'Delivery note {invoiceNumber} from {companyName}',
      body:
        '{salutation} {customerName},\n\n' +
        'Please find attached delivery note {invoiceNumber} for your delivery.\n\n' +
        'It is attached as a PDF.\n\n' +
        'Kind regards,\n{companyName}',
    },
    zh: {
      subject: '送货单 {invoiceNumber} 来自 {companyName}',
      body:
        '{salutation}{customerName}:\n\n' +
        '随信附上本次交货的送货单 {invoiceNumber}。\n\n' +
        '送货单以 PDF 格式附在邮件中。\n\n' +
        '此致\n敬礼\n\n' +
        '{companyName}',
    },
  },
};

export function renderInvoiceEmail(
  lang: EmailLang,
  vars: InvoiceEmailVars,
  documentType?: string,
): RenderedInvoiceEmail {
  const table = (documentType && DOCUMENT_TEMPLATES[documentType]) || TEMPLATES;
  const tpl = table[lang] || table.de;
  // Tier 689: the e-mail is plain text — the name was HTML-escaped, so
  // "Müller & Söhne" arrived as "Müller &amp; Söhne", "O'Brien" as "O&#39;Brien".
  const safeVars = {
    ...vars,
    customerName: vars.customerName || '',
  };
  const sub = (s: string): string =>
    s.replace(/\{(\w+)\}/g, (_m, k: string) => {
      const v = (safeVars as any)[k];
      return v === undefined || v === null ? '' : String(v);
    });
  // Tier 691: a greeting without a name ("Sehr geehrte Damen und Herren")
  // leaves "{salutation} {customerName}," as "… Herren ," — no space before it
  return { subject: sub(tpl.subject), text: sub(tpl.body).replace(/ +,/g, ',') };
}

/**
 * Tier 691 — the greeting of a customer. A company without a contact person
 * is "Sehr geehrte Damen und Herren" (it was "Sehr geehrte/r Müller &
 * Söhne"); the contact person, or a private customer, by name. `chosen` is
 * the salutation picked in the send dialog — it is used with the name.
 */
export function greetingFor(
  lang: EmailLang,
  customer: { name?: string | null; type?: string | null; contact?: unknown } | null | undefined,
  chosen?: string | null,
): { salutation: string; customerName: string } {
  const contact = String((customer?.contact as { name?: unknown } | null)?.name ?? '').trim()
  const name = contact || String(customer?.name ?? '').trim()
  if (chosen && chosen.trim()) return { salutation: chosen.trim(), customerName: name }
  if (!contact && customer?.type === 'business' && lang !== 'zh') {
    return { salutation: lang === 'en' ? 'Dear Sir or Madam' : 'Sehr geehrte Damen und Herren', customerName: '' }
  }
  // Tier 705: a name entered with its title — „Frau Weber“ — was greeted
  // „Sehr geehrte/r Frau Weber“. The title says which form is right.
  const titled = /^(Frau|Herr)\s+\S/.exec(name)
  if (titled && lang === 'de') {
    return { salutation: titled[1] === 'Frau' ? 'Sehr geehrte' : 'Sehr geehrter', customerName: name }
  }
  if (titled && lang === 'en') {
    return { salutation: 'Dear', customerName: name.replace(/^Frau\s+/, 'Ms ').replace(/^Herr\s+/, 'Mr ') }
  }
  return { salutation: defaultSalutationFor(lang, !!name), customerName: name }
}

/**
 * Tier 705: the words before the comma of a letter's first line — „Sehr
 * geehrte Damen und Herren“, „Sehr geehrte Frau Weber“, „Sehr geehrte/r Max
 * Muster“. The reminders, the Mahnung letter and the account statement wrote
 * „Sehr geehrte/r <name>“ whatever the name was — „Sehr geehrte/r Kunde AG“
 * for a company (the invoice e-mail stopped that in Tier 691).
 */
export function greetingLine(
  lang: EmailLang,
  customer: { name?: string | null; type?: string | null; contact?: unknown } | null | undefined,
): string {
  const { salutation, customerName } = greetingFor(lang, customer)
  return [salutation, customerName].filter(Boolean).join(' ')
}

// BC helper for the old call site (single arg with no
// salutation). Replaced by the form-modal flow, kept
// here for unit tests and for the `default` code
// path that doesn't have user overrides.
export function defaultSalutationFor(lang: EmailLang, hasName: boolean): string {
  if (!hasName) return '';
  if (lang === 'de') return 'Sehr geehrte/r';
  if (lang === 'en') return 'Dear';
  return '尊敬的';
}
