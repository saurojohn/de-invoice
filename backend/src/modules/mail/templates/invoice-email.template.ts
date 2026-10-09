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

// HTML-escape for the customer name (defence-in-depth
// against template-injection — the user-supplied name
// is the only field that comes from outside the
// template file, so it's the only one that needs
// escaping).
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const safeVars = {
    ...vars,
    customerName: esc(vars.customerName || ''),
  };
  const sub = (s: string): string =>
    s.replace(/\{(\w+)\}/g, (_m, k: string) => {
      const v = (safeVars as any)[k];
      return v === undefined || v === null ? '' : String(v);
    });
  return { subject: sub(tpl.subject), text: sub(tpl.body) };
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
