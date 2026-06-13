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

export function renderInvoiceEmail(
  lang: EmailLang,
  vars: InvoiceEmailVars,
): RenderedInvoiceEmail {
  const tpl = TEMPLATES[lang] || TEMPLATES.de;
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
