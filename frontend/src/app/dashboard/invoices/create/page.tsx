"use client"

import { Suspense } from "react"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { apiGet, apiPost, apiPut, apiFetch, ApiError } from "@/lib/api"

type InvoiceType = 'INV' | 'CN' | 'PI' | 'RCV'
type InvoiceTemplateType = 'standard' | 'simplified' | 'compact'

interface Customer {
  id: string
  name: string
  // Backend-assigned per-company sequential number (K-00001...).
  // Shown in the dropdown so the user can pick by either
  // name or number.
  customerNumber?: string | null
  vatId?: string | null
  type?: string
  taxExempt?: boolean
  // Address is stored as a JSON object on Customer.
  // The fields most useful in the picker dropdown are
  // street, postalCode, city and country.
  address?: { street?: string; postalCode?: string; city?: string; country?: string } | null
  // Contact info (email + phone) — also stored as JSON.
  contact?: { email?: string; phone?: string } | null
  paymentTerms?: number
  // Pre-extracted by the backend for search:
  //   cityText       — the value of address.city
  //   postalCodeText — the value of address.postalCode
  // (defined as STORED GENERATED columns in the DB so the
  // trigram GIN index can search them; see prisma/init.sql).
  cityText?: string | null
  postalCodeText?: string | null
}

interface Product {
  id: string
  name: string
  // Rich description used as the line-item text on the
  // invoice (selectProduct picks this over name when set,
  // because many products use the `name` field as an
  // internal code and put the customer-facing label in
  // `description`).
  description?: string | null
  sku: string
  unit: string
  basePrice: string
  vatRate: string
}

interface Invoice {
  id: string
  invoiceNumber: string
  customerId: string
  customer: { name: string }
  // Reference-copy fields used by "Vorlage kopieren" and the
  // per-row prefill on item copy. Optional because we don't
  // load the full nested set in every list view.
  items?: InvoiceItem[]
}

interface InvoiceItem {
  productId?: string
  // Produktnummer / SKU. Auto-filled when a product is picked
  // from the dropdown, but user-editable so manual line items
  // can carry a custom reference. Optional because the field
  // is only shown when non-empty in the PDF line item table.
  productNumber?: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  vatRate: number
}

function CreateInvoicePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get("id") || null
  // Tier 160: clone-as-draft. When set, the create
  // page prefills from the source invoice (via
  // GET /invoices/:id) but treats the result as a
  // NEW draft (issueDate=today, no invoice number,
  // status=draft). The user reviews + edits before
  // saving.
  const cloneFromId = searchParams.get("cloneFrom") || null
  const isEdit = !!editId
  const isClone = !!cloneFromId
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  // Tier 39: distinct cost centers the company has stamped
  // on past invoices. Drives the datalist for the
  // cost-center input above. Loaded once on mount —
  // not reactive to mid-session new-stamps (the user
  // can refresh to re-pull), which matches the read-only
  // metadata nature of the dropdown.
  const [costCenters, setCostCenters] = useState<string[]>([])
  // Tier 156: Bemerkungstext templates. Loaded once
  // on mount; rendered as a dropdown next to the notes
  // input. Selecting one appends the rendered text to
  // form.notes.
  const [noteTemplates, setNoteTemplates] = useState<Array<{
    id: string
    label: string
    text: string
    isDefault?: boolean
  }>>([])
  const [customerSearch, setCustomerSearch] = useState("")
  const [productSearch, setProductSearch] = useState("")
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [showProductDropdown, setShowProductDropdown] = useState(false)
  const [activeItemIndex, setActiveItemIndex] = useState<number | null>(null)
  // Product-number search: a SEPARATE picker from the description-
  // triggered one. Triggered by typing into the Artikelnr. input
  // (see item row). When the user types a SKU that doesn't exist
  // yet, the dropdown shows a "Create new product" suggestion
  // that opens the newProductModal.
  const [productNumberSearch, setProductNumberSearch] = useState("")
  const [showProductNumberDropdown, setShowProductNumberDropdown] = useState(false)
  // Inline modal for "create a new product from the line item".
  // The field set mirrors the products page's create/edit
  // form 1:1 (see src/app/dashboard/products/page.tsx) so the
  // user gets the same UX in both places — no surprise gaps
  // when they later edit the product on the products page.
  // The "open" flag is just for visibility; the rest is
  // initialized to the same defaults the products form uses.
  const [newProductModal, setNewProductModal] = useState<{
    open: boolean
    name: string
    description: string
    sku: string
    type: "good" | "service"
    unit: string
    basePrice: string
    vatRate: string
    trackInventory: boolean
    stockQuantity: string
    lowStockThreshold: string
    index: number
    loading: boolean
  } | null>(null)
  // Inline modal for "create a new customer from the invoice".
  // Field set mirrors the customers page's create/edit form
  // 1:1 (see src/app/dashboard/customers/page.tsx) so the
  // user gets the same UX in both places. Triggered by
  // clicking the "+ Neuen Kunden anlegen" link in the
  // customer picker dropdown when 0 customers match the
  // typed search.
  const [newCustomerModal, setNewCustomerModal] = useState<{
    open: boolean
    name: string
    vatId: string
    type: "business" | "individual"
    street: string
    postalCode: string
    city: string
    country: string
    taxExempt: boolean
    paymentTerms: number
    email: string
    phone: string
    loading: boolean
  } | null>(null)
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('INV')
  const [showInvoiceDropdown, setShowInvoiceDropdown] = useState(false)
  const [invoiceSearch, setInvoiceSearch] = useState("")
  const [templateType, setTemplateType] = useState<InvoiceTemplateType>('standard')
  const [form, setForm] = useState({
    customerId: "",
    referenceInvoiceId: "",
    issueDate: new Date().toISOString().split("T")[0],
    dueDate: "",
    // Default the Liefertermin to today. Most invoices are
    // issued and delivered the same day, and a pre-filled date
    // is easier to clear than to type. The PDF will show
    // "Liefertermin: <today>" by default; the user can clear
    // the input to hide the row on the PDF.
    deliveryDate: new Date().toISOString().split("T")[0],
    notes: "",
    discountPercent: 0,
    discountAmount: 0,
    // Tier 52: Skonto (cash discount for early
    // payment). Both fields together or both 0/empty
    // — the server enforces the atomic-pair rule.
    skontoPercent: 0,
    skontoDays: 0,
    paymentMethod: "bank_transfer",
    paymentTerms: 0,
    // Tier 27: USt-Behandlung. The radio group
    // maps to two wire fields (reverseCharge +
    // euTransaction). 'standard' = both false;
    // 'reverseCharge' = reverseCharge=true;
    // 'euTransaction' = euTransaction=true;
    // 'kleinunternehmer' = both false + totalVat
    // = 0 (the user should also check the §19 box
    // in the company settings; we don't enforce
    // it here, the DATEV export will still write
    // '0' as the USt-Schlüssel).
    //
    // We keep the wire fields in form state too,
    // so the payload below is explicit. The radio
    // is a derived view.
    reverseCharge: false,
    euTransaction: false,
    // Tier 39: DATEV Kostenstelle 1 + Kostenträger. Free-form
    // strings (not FK-restricted) — the dropdown below is
    // populated from GET /invoices/cost-centers (returns the
    // distinct values the company has ever stamped). The user
    // can also type a new value; the e2e 67 covers that path.
    costCenter: "",
    costObject: "",
    // Tier 118: multi-currency. The invoice can be
    // issued in any ISO 4217 currency the company has
    // rates for. The default is EUR (most B2B
    // invoices in Germany). When set to a non-EUR
    // code, the backend looks up the ECB rate and
    // stores the EUR equivalent for cross-currency
    // aggregation (EÜR, UStVA, BWA).
    currency: "EUR",
    // Rechnungssprache — default to the current UI locale so the
    // user doesn't have to change anything when their UI is already
    // in the language they want the invoice in. They can still
    // override per-invoice (e.g. UI in DE, customer in EN).
    language: getDateLocale(),
    items: [{ description: "", productNumber: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }] as InvoiceItem[],
  })
  const [loading, setLoading] = useState(false)
  // Tier 62: USt-Behandlung auto-suggestion. Set when the
  // user picks a customer; the radio group pre-fills with
  // `suggestion.suggested` and the "Auto-Erkennung" hint
  // shows `suggestion.reason`. The user can always override.
  const [ustSuggestion, setUstSuggestion] = useState<{
    suggested: 'standard' | 'reverseCharge' | 'euTransaction' | 'kleinunternehmer'
    reason: string
    customerHasVatId: boolean
    isEuB2b: boolean
  } | null>(null)
  // Top-of-page error from the initial-load fetch (e.g. 403 when
  // opening an old invoice in edit mode). Set here so we don't
  // crash when the user lands on /create?id=<old> directly.
  const [loadError, setLoadError] = useState<string | null>(null)
  // Tier 150: possible-duplicate warning. While the user
  // is filling the form, we ask the backend "is there
  // already an invoice like this one?" and surface the
  // matches in a banner above the form. The user can
  // still submit — this is a warning, not a block.
  //
  // We only run on NEW invoices (isEdit === false). In
  // edit mode every invoice trivially matches itself, so
  // the banner would always be red and just be noise.
  const [duplicates, setDuplicates] = useState<Array<{
    id: string
    invoiceNumber: string
    type: string
    status: string
    total: number
    currency: string
    issueDate: string
  }>>([])

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }

    // Tier 160: extract the prefill logic into a
    // shared helper so edit + clone both use it
    // with the same defaults. The only difference
    // is the "new-invoice" overrides (issueDate,
    // no invoice number) that clone needs.
    const prefillFromInvoice = (inv: any, opts: { isClone: boolean }) => {
      setInvoiceType(inv.type || 'INV')
      setTemplateType(inv.templateType || 'standard')
      if (inv.customer?.name) {
        setCustomerSearch(inv.customer.name)
      } else {
        setCustomerSearch(inv.customerId || '')
      }
      setForm({
        customerId: inv.customerId || '',
        referenceInvoiceId: inv.referenceInvoiceId || '',
        // For clone, use today as issueDate; for
        // edit, keep the source's issueDate.
        issueDate: opts.isClone
          ? new Date().toISOString().split("T")[0]
          : (inv.issueDate
              ? String(inv.issueDate).slice(0, 10)
              : new Date().toISOString().split("T")[0]),
        // For clone, clear the dueDate so the user
        // picks a new one (the source's dueDate is
        // probably in the past now).
        dueDate: opts.isClone
          ? ""
          : (inv.dueDate ? String(inv.dueDate).slice(0, 10) : ""),
        deliveryDate: inv.deliveryDate
          ? String(inv.deliveryDate).slice(0, 10)
          : new Date().toISOString().split("T")[0],
        notes: inv.notes || '',
        discountPercent: Number(inv.discountPercent || 0),
        discountAmount: Number(inv.discountAmount || 0),
        skontoPercent: Number(inv.skontoPercent || 0),
        skontoDays: Number(inv.skontoDays || 0),
        paymentMethod: inv.paymentMethod || 'bank_transfer',
        paymentTerms: inv.paymentTerms ?? 0,
        language: inv.language || getDateLocale(),
        costCenter: inv.costCenter || '',
        costObject: inv.costObject || '',
        reverseCharge: Boolean(inv.reverseCharge),
        euTransaction: Boolean(inv.euTransaction),
        currency: inv.currency || 'EUR',
        // Items: prefill either way. The user can
        // edit the qty / price before saving.
        items: (inv.items || []).map((it: any) => ({
          description: it.description || '',
          productNumber: it.productNumber || '',
          quantity: Number(it.quantity || 1),
          unit: it.unit || t("common2.unit"),
          unitPrice: Number(it.unitPrice || 0),
          vatRate: Number(it.vatRate ?? 0.19),
        })),
      })
    }

    // If we're in edit mode, prefill the form from the existing
    // invoice BEFORE the dropdown fetch effect. Without this the
    // page would render a blank create form and then suddenly
    // populate once the edit fetch resolves, which flashes the
    // wrong state.
    if (editId) {
      apiGet<any>(`/api/v1/invoices/${editId}?companyId=${companyId}`)
        .then((inv) => {
          if (!inv || !inv.id) return
          prefillFromInvoice(inv, { isClone: false })
        })
        .catch((err) => {
          // 403 = not same day (or wrong permissions). Show the
          // error inline rather than silently redirecting.
          const msg = err instanceof ApiError ? err.message : 'Rechnung konnte nicht geladen werden.'
          setLoadError(msg)
        })
    }

    // Tier 160: clone-as-draft. Same fetch as edit,
    // but with the new-invoice overrides
    // (issueDate=today, no dueDate, no invoice
    // number, items pre-filled). The form is
    // treated as a CREATE, not an EDIT — the
    // submit handler checks `isEdit` (not
    // `isClone`) so the POST endpoint is used.
    if (cloneFromId) {
      apiGet<any>(`/api/v1/invoices/${cloneFromId}?companyId=${companyId}`)
        .then((inv) => {
          if (!inv || !inv.id) return
          prefillFromInvoice(inv, { isClone: true })
        })
        .catch((err) => {
          const msg = err instanceof ApiError ? err.message : 'Quell-Rechnung konnte nicht geladen werden.'
          setLoadError(msg)
        })
    }

    Promise.all([
      apiGet<any>(`/api/v1/customers?companyId=${companyId}&pageSize=200`),
      apiGet<any>(`/api/v1/products?companyId=${companyId}&pageSize=200`),
      apiGet<any>(`/api/v1/invoices?companyId=${companyId}&pageSize=200`),
      // Tier 39: pull distinct cost centers for the picker
      // datalist. Soft-fail — a 200 with empty list is fine,
      // a 404 (very old backend) just leaves the dropdown empty.
      apiGet<{ costCenters: string[] }>(
        `/api/v1/invoices/cost-centers?companyId=${companyId}`,
      ).catch(() => ({ costCenters: [] })),
      // Tier 156: Bemerkungstext templates (notes
      // shortcuts). Soft-fail — a 404 (very old backend)
      // or 500 just leaves the dropdown empty so the
      // form still works without templates.
      apiGet<Array<{ id: string; label: string; text: string }>>(
        `/api/v1/note-templates?companyId=${companyId}`,
      ).catch(() => [] as any),
    ]).then(([c, p, inv, cc, nt]) => {
      setCustomers(Array.isArray(c) ? c : (c.data || []))
      setProducts(Array.isArray(p) ? p : (p.data || []))
      setInvoices(Array.isArray(inv) ? inv : (inv.data || []))
      setCostCenters(Array.isArray(cc?.costCenters) ? cc!.costCenters : [])
      setNoteTemplates(Array.isArray(nt) ? nt : [])
    }).catch((err) => {
      console.error('Invoice create dropdowns fetch failed:', err)
    })
  }, [router, cloneFromId, editId, getDateLocale, t])

  // Tier 176 (frontend): pre-fill the USt-Behandlung radio
  // and the dueDate from Company.defaultVatMode +
  // Company.defaultPaymentDays. Backend pre-fills the same
  // fields on save (see invoice.service.ts.create) but
  // showing the pre-selected radio on the form is better UX
  // than opening with "Standard" and having the user
  // re-pick. Skip in edit mode — the invoice already has
  // its own reverseCharge / euTransaction / dueDate.
  //
  // Only runs once on mount (no deps). If the company
  // default changes while the form is open, the user can
  // re-pick via the radio — we don't refetch.
  useEffect(() => {
    if (isEdit) return
    const companyId = typeof window !== "undefined"
      ? localStorage.getItem("companyId")
      : null
    if (!companyId) return
    fetch(`http://localhost:3001/api/v1/companies/${companyId}`, {
      headers: { "x-user-id": localStorage.getItem("userId") || "" },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((co) => {
        if (!co) return
        setForm((prev) => {
          // Don't clobber user-typed values if the form
          // is already populated (e.g. clone mode where
          // prefillFromInvoice ran first).
          if (prev.dueDate) return prev
          if (co.defaultPaymentDays && co.defaultPaymentDays > 0) {
            const issue = prev.issueDate
              ? new Date(prev.issueDate)
              : new Date()
            const due = new Date(issue.getTime() + co.defaultPaymentDays * 86400_000)
            // Skip pre-fill in clone mode: prefillFromInvoice
            // already sets dueDate to the cloned source's.
            if (!prev.dueDate) {
              return { ...prev, dueDate: due.toISOString().split("T")[0] }
            }
          }
          return prev
        })
        // The radio group is derived from reverseCharge /
        // euTransaction. Pre-select the radio if the company
        // has a defaultVatMode that's not 'standard' (standard
        // is the default with both booleans false, no
        // setForm needed).
        if (co.defaultVatMode === "reverseCharge") {
          setForm((prev) => ({ ...prev, reverseCharge: true, euTransaction: false }))
        } else if (co.defaultVatMode === "igL") {
          setForm((prev) => ({ ...prev, reverseCharge: false, euTransaction: true }))
        } else if (co.defaultVatMode === "kleinunternehmer") {
          // Kleinunternehmer = no USt. Backend already
          // recognises this. Frontend keeps the standard
          // radio (both false) — the §19 disclaimer is
          // added on the PDF via the company setting.
          // No radio change needed.
        }
        // 'standard' or null → both booleans stay false,
        // radio opens unselected. This is the existing
        // behaviour and matches the current default.
      })
      .catch(() => {
        // Soft-fail. The form is fully usable without
        // the pre-fill; the user can pick the radio
        // manually.
      })
  }, [isEdit])

  // Tier 150: watch the form for a likely-duplicate
  // combination (same customer + similar amount + nearby
  // issueDate) and surface a warning banner. Debounced
  // 500ms so a fast typer doesn't fire 10 requests per
  // keystroke. The effect depends on the three inputs
  // — customerId, issueDate, and the recomputed total
  // (recomputed via the calculateTotal() helper above
  // because total isn't a state field, it's derived).
  //
  // Only runs in create mode (not edit). In edit mode
  // the current invoice is itself a match, so the
  // banner would always show — not useful.
  useEffect(() => {
    if (isEdit) {
      setDuplicates([])
      return
    }
    const companyId = typeof window !== "undefined"
      ? localStorage.getItem("companyId")
      : null
    if (!companyId) return
    if (!form.customerId || !form.issueDate) {
      setDuplicates([])
      return
    }
    const total = calculateTotal()
    // No need to warn for €0 invoices (e.g. a draft
    // preview) — a €0 match would be every zero invoice
    // ever issued and would just be noise.
    if (!total || total <= 0) {
      setDuplicates([])
      return
    }
    const handle = setTimeout(() => {
      const params = new URLSearchParams({
        companyId,
        customerId: form.customerId,
        amount: String(total),
        issueDate: form.issueDate,
      })
      // Soft-fail: the duplicate check is a warning,
      // not a critical path. If the endpoint 404s (very
      // old backend) or 500s, just don't show the
      // banner. Logging to console for debugging.
      apiGet<{ matches: any[]; count: number }>(
        `/api/v1/invoices/duplicate-check?${params.toString()}`,
      )
        .then((res) => {
          if (res && Array.isArray(res.matches)) {
            setDuplicates(res.matches)
          } else {
            setDuplicates([])
          }
        })
        .catch((err) => {
          // Soft-fail. Don't crash the form.
          console.error("duplicate-check failed:", err)
          setDuplicates([])
        })
    }, 500)
    return () => clearTimeout(handle)
    // calculateTotal() reads from form.items /
    // form.discountPercent / form.discountAmount, so
    // we list them as deps to re-run on any line-item
    // or discount change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, form.customerId, form.issueDate, form.items, form.discountPercent, form.discountAmount, form.currency])

  // Search customers by name, customer number, VAT ID, city,
  // and postal code. Mirrors the backend's pg_trgm search
  // (which is the source of truth for ranked results) but
  // does the fuzzy match client-side for instant feedback as
  // the user types. The backend also exposes cityText and
  // postalCodeText as STORED GENERATED columns specifically
  // so this kind of cross-field search can read them
  // without parsing the address JSON each keystroke.
  const filteredCustomers = customers.filter(c => {
    const q = customerSearch.trim().toLowerCase()
    if (!q) return true
    return (
      (c.name || "").toLowerCase().includes(q) ||
      (c.customerNumber || "").toLowerCase().includes(q) ||
      (c.vatId || "").toLowerCase().includes(q) ||
      (c.cityText || c.address?.city || "").toLowerCase().includes(q) ||
      (c.postalCodeText || c.address?.postalCode || "").toLowerCase().includes(q)
    )
  })

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.sku && p.sku.toLowerCase().includes(productSearch.toLowerCase()))
  )

  const filteredInvoices = invoices.filter(inv =>
    inv.invoiceNumber.toLowerCase().includes(invoiceSearch.toLowerCase())
  )

  const selectCustomer = (customer: Customer) => {
    setForm({ ...form, customerId: customer.id })
    setCustomerSearch(customer.name)
    setShowCustomerDropdown(false)
    // Tier 62: fetch the USt-Behandlung auto-suggestion
    // so the radio group can prefill. We don't apply the
    // suggestion when the user has already made a manual
    // choice (the radio is sticky once clicked) — only on
    // first customer selection.
    const companyId = typeof window !== "undefined"
      ? localStorage.getItem("companyId")
      : null
    if (!companyId) return
    apiGet<{
      suggested: 'standard' | 'reverseCharge' | 'euTransaction' | 'kleinunternehmer'
      reason: string
      customerHasVatId: boolean
      isEuB2b: boolean
    }>(
      `/api/v1/invoices/ust-behandlung-suggestion?companyId=${companyId}&customerId=${customer.id}`,
    )
      .then((s) => {
        setUstSuggestion(s)
        // Prefill the radio: map detector output → form
        // booleans. We do this only if the user hasn't
        // already chosen a tax treatment (the boolean
        // form fields default to false on a new invoice;
        // both false = 'standard' which is what the
        // detector defaults to when there's nothing to
        // detect, so the only "real" prefills are
        // reverseCharge=true or euTransaction=true).
        setForm((prev) => {
          // Don't override if the user has already
          // touched the radio. We detect "touched" by
          // checking if either flag is set OR if a
          // previous suggestion has been applied.
          // For new invoices both flags are false
          // initially, so the first apply is safe.
          // If the user has clicked the radio, we leave
          // their choice alone.
          // (The form doesn't currently track "touched"
          // state separately — for simplicity we apply
          // the suggestion only when the form is in
          // its initial state.)
          if (prev.reverseCharge || prev.euTransaction) {
            return prev
          }
          return {
            ...prev,
            reverseCharge: s.suggested === 'reverseCharge',
            euTransaction: s.suggested === 'euTransaction',
            // The kleinunternehmer treatment doesn't map
            // to either of our two booleans — it's
            // represented by leaving both false plus
            // zeroing the item VAT rates. The form
            // already does that when the user picks the
            // option, so we just leave a hint for them
            // via the suggestion.reason message.
          }
        })
      })
      .catch((err) => {
        // Soft-fail: the detector is a hint, not a
        // critical path. If the endpoint is down, the
        // user still sees the form with the default
        // 'standard' radio. Log to console for
        // debugging.
        console.error("ust-behandlung-suggestion failed:", err)
        setUstSuggestion(null)
      })
  }

  // Open the "create new customer" modal. Triggered from
  // the customer picker dropdown when 0 customers match
  // the typed search. The name field is pre-filled with
  // whatever the user typed (so they don't have to retype
  // it), and all other fields use the same defaults the
  // customers page's "create" form uses.
  const openNewCustomerModal = () => {
    const name = customerSearch.trim()
    setNewCustomerModal({
      open: true,
      name,
      vatId: "",
      type: "business",
      street: "",
      postalCode: "",
      city: "",
      country: "DE",  // match the customers page's default
      taxExempt: false,
      paymentTerms: 30,  // match the customers page's default
      email: "",
      phone: "",
      loading: false,
    })
    setShowCustomerDropdown(false)
  }

  // Save the new customer via POST /api/v1/customers and
  // auto-select it for the invoice. Mirrors the
  // createProductFromSku flow above: same UX, same
  // field-shape parity with the customers page, same
  // immediate-pick-up after save.
  const createCustomerFromName = async () => {
    if (!newCustomerModal) return
    if (!newCustomerModal.name.trim()) {
      toast.warn(t("invoice.newCustomerName"))
      return
    }
    setNewCustomerModal({ ...newCustomerModal, loading: true })
    try {
      const companyId = localStorage.getItem("companyId") || "7de697d5-64a2-4632-9a87-d18b4e2a0214"
      const created = await apiPost<Customer>(
        `/api/v1/customers?companyId=${companyId}`,
        {
          name: newCustomerModal.name.trim(),
          vatId: newCustomerModal.vatId.trim() || undefined,
          type: newCustomerModal.type,
          // Address: only send non-empty sub-fields so the
          // backend doesn't store empty strings. The DTO
          // trims and accepts all of these as @IsOptional.
          address: {
            street: newCustomerModal.street.trim() || undefined,
            postalCode: newCustomerModal.postalCode.trim() || undefined,
            city: newCustomerModal.city.trim() || undefined,
            country: newCustomerModal.country.trim() || undefined,
          },
          contact: {
            email: newCustomerModal.email.trim() || undefined,
            phone: newCustomerModal.phone.trim() || undefined,
          },
          taxExempt: newCustomerModal.taxExempt,
          paymentTerms: newCustomerModal.paymentTerms,
        }
      )
      // Add the new customer to the in-memory list so any
      // future search can see it (no refetch).
      setCustomers((prev) => [...prev, created])
      // Auto-pick the new customer on the invoice.
      selectCustomer(created)
      setNewCustomerModal(null)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      toast.error(msg)
      setNewCustomerModal({ ...newCustomerModal, loading: false })
    }
  }

  const selectProduct = (product: Product, index: number) => {
    const items = [...form.items]
    items[index] = {
      productId: product.id,
      // Use the product's rich description as the line-item
      // description, not the product's internal name. Many
      // products in this app use the `name` field as a short
      // code (e.g. "T13", "Mutter M5") and put the real
      // customer-facing label in `description` (e.g.
      // "Damentasche", "Sechskant-Stahlmutter M5 verzinkt").
      // For products with no description, fall back to the
      // name so the line item is never empty.
      //
      // This applies to ALL three picker flows:
      //   1. Description-dropdown picker (typing into the
      //      description field)
      //   2. Artikelnr.-dropdown picker (typing into the
      //      SKU field)
      //   3. Inline "Create new product" modal — when the
      //      user fills in the description field of the
      //      modal, that description now flows to the
      //      invoice line item as expected.
      description: (product.description?.trim() || product.name),
      // Auto-fill the SKU from the product master. The user can
      // still override this in the line-item row (e.g. to carry
      // a customer-specific part number on the invoice).
      productNumber: product.sku || "",
      quantity: 1,
      unit: product.unit,
      unitPrice: parseFloat(product.basePrice),
      vatRate: parseFloat(product.vatRate),
    }
    setForm({ ...form, items })
    setProductSearch("")
    setProductNumberSearch("")
    setShowProductDropdown(false)
    setShowProductNumberDropdown(false)
    setActiveItemIndex(null)
  }

  // Open the "create new product" modal. Triggered from the
  // product-number dropdown when 0 products match the typed
  // SKU. Mirrors the products page's "create" form layout
  // 1:1 so the user sees the same fields in both places.
  // Defaults match the products page exactly.
  const openNewProductModal = (index: number) => {
    const sku = (form.items[index]?.productNumber || "").trim()
    setNewProductModal({
      open: true,
      // Pre-fill the name with the SKU so the user can just
      // press Enter if the SKU is descriptive enough. They
      // can still edit it.
      name: sku,
      description: "",
      sku,
      type: "good",
      unit: t("common2.unit") || "Stück",
      // basePrice is a string in the products form so the
      // input can be empty without becoming NaN; the service
      // handles the empty-string → 0 coercion.
      basePrice: "",
      vatRate: "0.19",
      trackInventory: false,
      stockQuantity: "0",
      lowStockThreshold: "",
      index,
      loading: false,
    })
    setShowProductNumberDropdown(false)
  }

  // Save the new product via POST /api/v1/products, then
  // auto-select it for the originating line item. Mirrors
  // the user-flow of typing the SKU → not finding it →
  // creating it on the spot → it instantly being available.
  // The payload shape matches the products page's create
  // form 1:1 (no fields renamed, no defaults omitted) so
  // a product created here behaves identically to one
  // created from /dashboard/products.
  const createProductFromSku = async () => {
    if (!newProductModal) return
    const { name, index } = newProductModal
    if (!name.trim()) {
      toast.warn(t("invoice.newProductName"))
      return
    }
    setNewProductModal({ ...newProductModal, loading: true })
    try {
      const companyId = localStorage.getItem("companyId") || "7de697d5-64a2-4632-9a87-d18b4e2a0214"
      // Same payload shape as the products page's handleSubmit:
      // string basePrice (server coerces to Decimal), string
      // vatRate (server normalizes >1 to decimal), string
      // stockQuantity + lowStockThreshold, all optional except
      // name + basePrice.
      const created = await apiPost<{ id: string; name: string; sku: string; unit: string; basePrice: string; vatRate: string }>(
        `/api/v1/products?companyId=${companyId}`,
        {
          name: newProductModal.name.trim(),
          description: newProductModal.description.trim() || undefined,
          sku: newProductModal.sku.trim() || undefined,
          type: newProductModal.type,
          unit: newProductModal.unit.trim() || undefined,
          // basePrice: empty string is acceptable for "0" — the
          // server's @Min(0) validator rejects negatives. Send
          // 0 (not "") so the products page can later display
          // the product with a clean price column.
          basePrice: newProductModal.basePrice === "" ? 0 : Number(newProductModal.basePrice),
          vatRate: Number(newProductModal.vatRate),
          trackInventory: newProductModal.trackInventory,
          stockQuantity: Number(newProductModal.stockQuantity) || 0,
          // lowStockThreshold: send null when the user hasn't
          // filled it in (so the product has no threshold),
          // and a number otherwise. Don't send 0 — that's a
          // real threshold of "alert when stock is 0 or below".
          lowStockThreshold: newProductModal.lowStockThreshold.trim() === ""
            ? null
            : Number(newProductModal.lowStockThreshold),
        }
      )
      // Refresh the in-memory products list so the user can
      // see the new entry in any future search.
      setProducts((prev) => [...prev, created])
      // Auto-fill the originating line item with the new
      // product's data.
      selectProduct(created, index)
      setNewProductModal(null)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      toast.error(msg)
      setNewProductModal({ ...newProductModal, loading: false })
    }
  }

  const selectReferenceInvoice = (invoice: Invoice) => {
    // When picking a reference invoice for a credit note, auto-fill:
    //   1. customerId — from the original invoice's customer
    //      (so the backend stores the right customer for the CN)
    //   2. items — copy items from the original, with negative amounts
    //      so the CN reverses the original totals. User can edit
    //      quantities / add/remove rows before submitting.
    const refCustomerId = invoice.customerId || ""
    const refCustomerName = invoice.customer?.name || ""
    const refItems = (invoice.items || []).map((it) => ({
      description: it.description,
      productNumber: it.productNumber || "",
      quantity: Number(it.quantity),
      unit: it.unit,
      unitPrice: Number(it.unitPrice),
      vatRate: Number(it.vatRate),
    }))
    setForm({
      ...form,
      referenceInvoiceId: invoice.id,
      customerId: refCustomerId,
      items: refItems.length > 0
        ? refItems
        : [{ description: "", productNumber: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 }],
    })
    setInvoiceSearch(invoice.invoiceNumber)
    setCustomerSearch(refCustomerName)
    setShowInvoiceDropdown(false)
  }

  const getInvoiceTypeLabel = (type: InvoiceType) => {
    const labels: Record<InvoiceType, string> = {
      INV: t("invoice.typeInvoice"),
      CN: t("invoice.typeCreditNote"),
      PI: t("invoice.typeProforma"),
      RCV: t("invoice.typeReceipt"),
    }
    return labels[type]
  }

  const getInvoiceTypeColor = (type: InvoiceType) => {
    const colors: Record<InvoiceType, string> = {
      INV: "bg-blue-100 text-blue-700 dark:text-blue-300",
      CN: "bg-orange-100 text-orange-700 dark:text-orange-300",
      PI: "bg-purple-100 text-purple-700 dark:text-purple-300",
      RCV: "bg-green-100 text-green-700 dark:text-green-300",
    }
    return colors[type]
  }

  // Append a new empty item to the END of the items list.
  // Kept for backward compatibility (no longer wired to a
  // button, but callers might still depend on the shape).
  // Insert a new empty item row directly AFTER the row at
  // \`index\`. The new row inherits the same defaults as
  // addItem() (description + productNumber empty, quantity
  // 1, unit from i18n, price 0, VAT 19%). Splicing after
  // the clicked row is the "insert below" pattern \u2014
  // useful when the user wants to add a related line below
  // a specific item rather than always at the end of the
  // list. If the clicked index is out of range, falls back
  // to appending at the end so we never end up with a
  // broken state.
  const addItemAt = (index: number) => {
    setForm({
      ...form,
      items: [
        ...form.items.slice(0, index + 1),
        { description: "", productNumber: "", quantity: 1, unit: t("common2.unit"), unitPrice: 0, vatRate: 0.19 },
        ...form.items.slice(index + 1),
      ],
    })
  }

  const calculateSubtotal = () => {
    return form.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  }

  const calculateDiscount = () => {
    if (form.discountPercent > 0) {
      return calculateSubtotal() * (form.discountPercent / 100)
    }
    return form.discountAmount
  }

  const calculateVat = () => {
    return form.items.reduce((sum, item) => {
      const itemNet = item.quantity * item.unitPrice
      return sum + itemNet * item.vatRate
    }, 0)
  }

  const calculateTotal = () => {
    return calculateSubtotal() - calculateDiscount() + calculateVat()
  }

  // Tier 118: format an amount in the selected currency.
  // Uses Intl.NumberFormat for the per-currency symbol
  // placement; falls back to "<amount> <CCY>" for codes
  // Intl doesn't recognise (rare in practice).
  const fmtCurrency = (n: number, ccy: string): string => {
    try {
      return new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: ccy,
      }).format(n)
    } catch {
      return `${n.toFixed(2)} ${ccy}`
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await saveAndNavigate(false)
  }

  // "Speichern und drucken" — same as handleSubmit but after
  // creating the invoice we open its PDF in a new tab and
  // immediately trigger window.print() so the user lands
  // straight in the system print dialog. Faster workflow for
  // B2B where most invoices go straight to the printer.
  const handleSaveAndPrint = async (e: React.MouseEvent) => {
    e.preventDefault()
    await saveAndNavigate(true)
  }

  // Shared body for both submit handlers. When `printAfter` is
  // true, we fetch the generated PDF with auth headers, turn
  // it into a same-origin blob URL, open that in a new tab
  // and fire window.print(). Using a blob URL (instead of a
  // relative `/api/v1/...` path) avoids the 404 trap: a
  // relative path opened in a new tab is resolved against the
  // CURRENT origin (the frontend dev server on :3000), not
  // the backend on :3001, and Next.js has no such route. The
  // blob URL is served from the frontend's own origin, so the
  // PDF viewer can display it and the print dialog fires
  // correctly. We navigate to the invoice detail page in
  // parallel so the user can also see the created invoice in
  // the dashboard.
  const saveAndNavigate = async (printAfter: boolean) => {
    // Validation — credit notes (CN) need a reference invoice, NOT
    // a directly-picked customer (the customer is copied from the
    // reference). For all other types, customer is required.
    if (invoiceType === 'CN') {
      if (!form.referenceInvoiceId) {
        toast.warn(t("common2.referenceInvoice") + " " + t("common.required"))
        return
      }
    } else if (!form.customerId) {
      toast.warn(t("common2.selectCustomer"))
      return
    }

    setLoading(true)

    try {
      const companyId = localStorage.getItem("companyId") || "7de697d5-64a2-4632-9a87-d18b4e2a0214"
      // Strip empty-string date fields before sending. Backend's
      // @IsOptional() only skips null/undefined, not "" — and
      // @IsDateString() rejects "". We removed the Fälligkeits-
      // datum input from the form (it's auto-computed from the
      // Zahlungsziel dropdown on the backend), so dueDate is
      // always empty here. deliveryDate is pre-filled with
      // today's date by default, but the user can clear it; if
      // cleared, treat it as "not set" instead of "set to empty".
      const payload = {
        ...form,
        type: invoiceType,
        templateType,
        dueDate: form.dueDate || undefined,
        deliveryDate: form.deliveryDate || undefined,
        // Tier 39: drop empty-string costCenter/costObject so
        // the backend sees `undefined` (column→null) rather
        // than `""` (whitespace stored as truthy string).
        // Non-empty values flow through verbatim.
        costCenter: form.costCenter?.trim() || undefined,
        costObject: form.costObject?.trim() || undefined,
        // Tier 52: Skonto. Drop the pair when the user
        // hasn't filled in both fields. The server also
        // enforces "both or neither" — sending a lone
        // percent would just be stored as null on both
        // sides, but trimming here keeps the wire clean.
        ...(form.skontoPercent > 0 && form.skontoDays > 0
          ? {
              skontoPercent: form.skontoPercent,
              skontoDays: form.skontoDays,
            }
          : {}),
      }
      let createdId: string | null = null
      if (isEdit && editId) {
        // Edit mode: PUT replaces items wholesale and recomputes
        // totals. The service enforces same-day on the existing
        // invoice; if you landed here with a stale link the 403
        // will be surfaced in the alert below.
        await apiPut(`/api/v1/invoices/${editId}?companyId=${companyId}`, payload)
        createdId = editId
      } else {
        const result = await apiPost<{ id: string }>(`/api/v1/invoices?companyId=${companyId}`, payload)
        createdId = result.id
      }

      if (printAfter && createdId) {
        // Fetch the PDF with auth headers (apiFetch attaches
        // x-user-id + x-company-id from localStorage), then
        // build a same-origin blob URL the new tab can load.
        const cacheBust = `t=${Date.now()}`
        const pdfPath = `/api/v1/invoices/${createdId}/pdf?companyId=${companyId}&${cacheBust}`
        const response = await apiFetch(pdfPath, { throwOnError: false })
        if (!response.ok) {
          // The invoice was created (we have createdId) but the
          // PDF fetch failed — surface the error but still
          // navigate to the detail page so the user can
          // download manually from there.
          const msg = response.status === 401 || response.status === 403
            ? "Sitzung abgelaufen — bitte neu anmelden"
            : `PDF konnte nicht geladen werden (HTTP ${response.status})`
          toast.error(msg)
          // Fall through to the navigation below
        } else {
          const blob = await response.blob()
          const blobUrl = URL.createObjectURL(blob)
          const printWindow = window.open(blobUrl, "_blank")
          if (printWindow) {
            // Give the PDF viewer ~1.5s to load before firing
            // print. Most PDF viewers (Chrome/Edge/Firefox
            // built-in, plus the Adobe extension) will then
            // show the system print dialog automatically.
            // The user can also hit Cmd/Ctrl+P manually if
            // the dialog doesn't auto-appear.
            setTimeout(() => {
              try {
                printWindow.focus()
                printWindow.print()
              } catch (e) {
                // The blob URL is same-origin, so print() should
                // succeed; if it doesn't (very rare — e.g. user
                // closed the new tab), we silently no-op. The
                // blob is still downloadable from the new tab.
                console.error("Auto-print failed:", e)
              }
              // Revoke the blob URL after the print dialog has
              // had a chance to read the blob. The PDF is fully
              // rendered in the new tab by now, so this is safe.
              setTimeout(() => URL.revokeObjectURL(blobUrl), 5000)
            }, 1500)
          } else {
            // Popup blocked — fall back to triggering a
            // download in the current tab. The user can then
            // open the downloaded PDF and print from there.
            const a = document.createElement("a")
            a.href = blobUrl
            a.download = `rechnung-${createdId}.pdf`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(blobUrl), 10000)
          }
        }
      }

      // Always navigate back to the invoice detail (or list)
      // so the user has the invoice in their history.
      if (isEdit && editId) {
        router.push(`/dashboard/invoices/${editId}`)
      } else {
        router.push("/dashboard/invoices")
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Netzwerkfehler: ${err}`
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {isEdit
              ? (t("invoice.edit") || "Rechnung bearbeiten")
              : isClone
                ? "🔁 " + (t("invoice.cloneTitle") || "Als neuen Entwurf kopieren")
                : t("invoice.create")}
          </h1>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard/invoices")}>{t("common.cancel")}</Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Load error (e.g. opening an old invoice for edit). The
            form is still rendered below so the user can read
            what's there and back out via "Abbrechen". */}
        {loadError && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2">
            ⚠ {loadError}{" "}
            <button
              type="button"
              onClick={() => router.push("/dashboard/invoices")}
              className="ml-2 underline"
            >
              {t("common.back") || "Zurück zur Liste"}
            </button>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Tier 150: Possible-duplicate warning banner.
              Shown when the backend finds existing invoices
              that match (customerId, amount±0.01, issueDate±7d).
              Click "Ansehen" on a row to jump to the
              suspected-duplicate invoice. This is a WARNING
              only — the user can still submit if they confirm
              it's a legitimate new invoice. */}
          {duplicates.length > 0 && (
            <div
              data-testid="duplicate-warning"
              className="border-l-4 border-amber-500 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-400 p-4 rounded-r shadow-sm"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl leading-none" aria-hidden="true">⚠️</span>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-1">
                    {t("invoice.duplicateCheckTitle")}
                  </h3>
                  <p className="text-sm text-amber-800 dark:text-amber-200 mb-3">
                    {t("invoice.duplicateCheckWarning", { count: duplicates.length })}
                  </p>
                  <ul className="space-y-1.5 text-sm">
                    {duplicates.slice(0, 3).map((d) => (
                      <li
                        key={d.id}
                        data-testid="duplicate-warning-row"
                        className="flex flex-wrap items-center gap-2 text-amber-900 dark:text-amber-100"
                      >
                        <span className="font-mono font-semibold">{d.invoiceNumber}</span>
                        <span className="text-amber-700 dark:text-amber-300">·</span>
                        <span>
                          {d.total.toLocaleString("de-DE", { style: "currency", currency: d.currency })}
                        </span>
                        <span className="text-amber-700 dark:text-amber-300">·</span>
                        <span>{String(d.issueDate).slice(0, 10)}</span>
                        <span className="text-amber-700 dark:text-amber-300">·</span>
                        <span className="text-xs uppercase tracking-wide">{d.status}</span>
                        <a
                          href={`/dashboard/invoices/${d.id}`}
                          target="_blank"
                          rel="noreferrer"
                          data-testid="duplicate-warning-link"
                          className="ml-auto underline text-amber-700 dark:text-amber-200 hover:text-amber-900 dark:hover:text-amber-50"
                        >
                          {t("invoice.duplicateCheckView")} →
                        </a>
                      </li>
                    ))}
                    {duplicates.length > 3 && (
                      <li className="text-xs text-amber-700 dark:text-amber-300 italic">
                        {t("invoice.duplicateCheckMore", { count: duplicates.length - 3 })}
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}
          {/* Basic Info Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("invoice.basicInfo")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Invoice Type Selector */}
              <div>
                <label className="block text-sm font-medium mb-1">{t("invoice.invoiceType")}</label>
                <div className="flex gap-2">
                  {(['INV', 'CN', 'PI', 'RCV'] as InvoiceType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        // When switching between invoice types, clear
                        // type-specific state (reference invoice for CN,
                        // customer for the rest) so the form starts clean.
                        setInvoiceType(type)
                        setForm((f) => ({
                          ...f,
                          referenceInvoiceId: "",
                          customerId: "",
                        }))
                        setInvoiceSearch("")
                        setCustomerSearch("")
                      }}
                      className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                        invoiceType === type
                          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:text-blue-300'
                          : 'border-gray dark:border-gray-700-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:bg-gray-900'
                      }`}
                    >
                      <span className={`px-2 py-0.5 rounded text-xs mr-1 ${getInvoiceTypeColor(type)}`}>
                        {type}
                      </span>
                      {getInvoiceTypeLabel(type)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Customer Search */}
              <div className="relative">
                <label className="block text-sm font-medium mb-1">
                  {invoiceType === "CN"
                    ? `${t("invoice.customer")} (${t("common.fromReferenceInvoice") || "aus Referenzrechnung"})`
                    : `${t("invoice.customer")} *`}
                </label>
                <Input
                  value={customerSearch}
                  onChange={(e) => {
                    setCustomerSearch(e.target.value)
                    setShowCustomerDropdown(true)
                    setForm({ ...form, customerId: "" })
                  }}
                  onFocus={() => setShowCustomerDropdown(customerSearch.length > 0 || true)}
                  onBlur={() => {
                    // Delay close so a click on a dropdown item
                    // (which fires AFTER blur) still registers.
                    // 200ms is the standard "let the click
                    // happen" delay.
                    setTimeout(() => setShowCustomerDropdown(false), 200)
                  }}
                  placeholder={t("invoice.selectCustomer")}
                  required={invoiceType !== 'CN'}
                  readOnly={invoiceType === 'CN' && !!form.customerId}
                  data-testid="invoice-customer-search"
                />
                {showCustomerDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg max-h-64 overflow-y-auto z-10">
                    {filteredCustomers.length === 0 ? (
                      <>
                        <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-sm border-b">
                          {t("common2.noCustomersFound")}
                        </div>
                        {/* No match: offer to create a new
                            customer with the typed name. The
                            name is pre-filled in the modal so
                            the user doesn't have to retype. */}
                        <div
                          className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-blue-700 dark:text-blue-300 text-sm font-medium border-t"
                          onMouseDown={(e) => {
                            // Use onMouseDown so the click
                            // fires BEFORE the input's blur
                            // handler closes the dropdown.
                            e.preventDefault()
                            openNewCustomerModal()
                          }}
                        >
                          + {t("invoice.createNewCustomerWithName").replace("{name}", customerSearch.trim() || "")}
                        </div>
                      </>
                    ) : (
                      filteredCustomers.map((c) => (
                        <div
                          key={c.id}
                          data-testid="invoice-customer-option"
                          className="px-3 py-2 hover:bg-blue-50 cursor-pointer border-b last:border-b-0"
                          onMouseDown={(e) => {
                            // onMouseDown so the click fires
                            // before the input's blur closes
                            // the dropdown.
                            e.preventDefault()
                            selectCustomer(c)
                          }}
                        >
                          {/* Show all the customer info the
                              user might use to disambiguate:
                              name (primary), customer number
                              (K-00001), VAT ID, full address
                              (street, postal + city, country),
                              email. Each is on its own line
                              so the dropdown stays scannable
                              even with 4-5 fields visible. */}
                          <div className="font-medium text-sm">{c.name}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-0.5">
                            {c.customerNumber && `${c.customerNumber} · `}
                            {c.vatId ? `USt-IDNr. ${c.vatId}` : (t("customer.noVatId") || "keine USt-ID")}
                          </div>
                          {c.address && (c.address.street || c.address.postalCode || c.address.city) && (
                            <div className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
                              {[c.address.street, [c.address.postalCode, c.address.city].filter(Boolean).join(" "), c.address.country].filter(Boolean).join(", ")}
                            </div>
                          )}
                          {c.contact?.email && (
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{c.contact.email}</div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Reference Invoice for Credit Note */}
              {invoiceType === 'CN' && (
                <div className="relative">
                  <label className="block text-sm font-medium mb-1">
                    {t("common2.referenceInvoice")} *
                  </label>
                  <Input
                    value={invoiceSearch}
                    onChange={(e) => {
                      setInvoiceSearch(e.target.value)
                      setShowInvoiceDropdown(e.target.value.length > 0)
                      setForm({ ...form, referenceInvoiceId: "" })
                    }}
                    onFocus={() => setShowInvoiceDropdown(invoiceSearch.length > 0 || true)}
                    placeholder={t("common2.searchInvoiceNumber")}
                  />
                  {showInvoiceDropdown && invoiceSearch && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                      {filteredInvoices.length === 0 ? (
                        <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-sm">
                          {t("common2.noInvoicesFound")}
                        </div>
                      ) : (
                        filteredInvoices.map((inv) => (
                          <div
                            key={inv.id}
                            className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                            onClick={() => selectReferenceInvoice(inv)}
                          >
                            <div className="font-medium text-sm">{inv.invoiceNumber}</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">{inv.customer?.name}</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.date")} *</label>
                  <Input
                    type="date"
                    value={form.issueDate}
                    onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
                    required
                    data-testid="invoice-issue-date"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.paymentTerms")}</label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.paymentTerms}
                    onChange={(e) => setForm({ ...form, paymentTerms: Number(e.target.value) })}
                    data-testid="invoice-payment-terms"
                  >
                    <option value={0}>{t("paymentTerm.immediate")}</option>
                    <option value={7}>{t("paymentTerm.days7")}</option>
                    <option value={14}>{t("paymentTerm.days14")}</option>
                    <option value={30}>{t("paymentTerm.days30")}</option>
                    <option value={60}>{t("paymentTerm.days60")}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.language") || "Rechnungssprache"}
                  </label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.language}
                    onChange={(e) => setForm({ ...form, language: e.target.value })}
                    title={t("invoice.languageHint") || "Sprache der Rechnung (kann von der UI-Sprache abweichen)"}
                    data-testid="invoice-language"
                  >
                    <option value="de-DE">Deutsch</option>
                    <option value="en-US">English</option>
                    <option value="zh-CN">中文</option>
                  </select>
                </div>

                {/* Tier 118: multi-currency. The invoice can be
                    issued in any currency the company has ECB
                    rates for. The default is EUR (most B2B).
                    For non-EUR the backend looks up the ECB rate
                    and stores the EUR equivalent for aggregation. */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.currency") || "Währung"}
                  </label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    title={t("invoice.currencyHint") || "ISO 4217 Währungscode. EUR bleibt unverändert; USD/CHF/GBP werden zum ECB-Tageskurs in EUR umgerechnet."}
                    data-testid="invoice-currency"
                  >
                    <option value="EUR">EUR (€)</option>
                    <option value="USD">USD ($)</option>
                    <option value="CHF">CHF (Fr.)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="JPY">JPY (¥)</option>
                    <option value="PLN">PLN (zł)</option>
                    <option value="CZK">CZK (Kč)</option>
                    <option value="CNY">CNY (¥)</option>
                  </select>
                </div>

                {/* Tier 39: DATEV Kostenstelle 1 + Kostenträger
                    stamps. The costCenter dropdown is populated
                    from GET /invoices/cost-centers (distinct list
                    the company has ever used). The user may also
                    type a new value — the column is free-form so
                    the DATEV import flow can land ad-hoc codes
                    without a migration. */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.costCenter") || "Kostenstelle (DATEV)"}
                  </label>
                  <input
                    list="tier39-cost-centers-list"
                    type="text"
                    value={form.costCenter}
                    onChange={(e) =>
                      setForm({ ...form, costCenter: e.target.value })
                    }
                    placeholder="z.B. VERTRIEB, 100, SERVICE"
                    className="w-full h-10 border rounded-md px-3 dark:bg-gray-800 dark:border-gray-700"
                    data-testid="invoice-cost-center"
                  />
                  <datalist id="tier39-cost-centers-list">
                    {costCenters.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.costObject") || "Kostenträger (DATEV)"}
                  </label>
                  <input
                    type="text"
                    value={form.costObject}
                    onChange={(e) =>
                      setForm({ ...form, costObject: e.target.value })
                    }
                    placeholder="z.B. PROJ-2026-Q3"
                    className="w-full h-10 border rounded-md px-3 dark:bg-gray-800 dark:border-gray-700"
                    data-testid="invoice-cost-object"
                  />
                </div>
              </div>

              {/* Tier 27: USt-Behandlung.
                  Single radio group, maps to the
                  two wire booleans (reverseCharge +
                  euTransaction). The radio value
                  is derived: 'standard' when both
                  false, 'reverseCharge' when
                  reverseCharge=true, etc.

                  Why a radio and not two checkboxes?
                  The two flags are mutually exclusive
                  in our business logic — the user
                  can't have BOTH §13b and §1a on
                  the same invoice (the backend
                  rejects it with 400). A radio makes
                  the exclusivity visible without
                  us having to enforce it client-side
                  (and it falls back to a meaningful
                  default on a stale browser tab).

                  When the user picks RC or IgE we
                  show a contextual help line with
                  the §-reference. For IgE we also
                  warn if the customer has no VAT-ID
                  — §1a UStG REQUIRES a valid
                  customer VAT-ID. The user can
                  still save (we don't block, some
                  micro-business customers don't
                  have one) but the warning is loud. */}
              <div className="mt-4 p-3 border rounded-md bg-gray-50" data-testid="invoice-tax-treatment">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium">
                    {t("invoice.taxTreatment")}
                  </label>
                  {ustSuggestion && (
                    <div className="flex items-center gap-2" data-testid="invoice-ust-suggestion-badges">
                      {ustSuggestion.customerHasVatId && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded font-medium bg-emerald-100 text-emerald-800"
                          data-testid="invoice-ust-suggestion-vatid-badge"
                          title={t("invoice.ustSuggestionVatIdTitle") || "USt-ID des Kunden erkannt"}
                        >
                          ✓ USt-ID
                        </span>
                      )}
                      {ustSuggestion.isEuB2b && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded font-medium bg-blue-100 text-blue-800"
                          data-testid="invoice-ust-suggestion-eub2b-badge"
                          title={t("invoice.ustSuggestionEuB2bTitle") || "EU-B2B — §1a oder §13b UStG"}
                        >
                          🇪🇺 EU B2B
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {/* Tier 62: Auto-Erkennung hint. Shows the reason
                    the detector picked this USt-Behandlung so
                    the Berater can confirm it's correct (and
                    pick §1a vs §13b for EU B2B). */}
                {ustSuggestion && (
                  <div
                    className="mb-2 p-2 rounded bg-blue-50 border border-blue-200 text-xs text-blue-900"
                    data-testid="invoice-ust-suggestion-hint"
                  >
                    <span className="font-medium">
                      {t("invoice.ustAutoDetected") || "Auto-Erkennung"}:
                    </span>{" "}
                    {ustSuggestion.reason}
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="taxTreatment"
                      value="standard"
                      checked={!form.reverseCharge && !form.euTransaction}
                      onChange={() => setForm({ ...form, reverseCharge: false, euTransaction: false })}
                      data-testid="invoice-tax-standard"
                    />
                    {t("invoice.taxTreatmentStandard")}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="taxTreatment"
                      value="reverseCharge"
                      checked={form.reverseCharge}
                      onChange={() => {
                        // Pick RC → zero out all item
                        // VAT rates. The user can
                        // override per row (e.g. a
                        // mixed line where one item
                        // IS taxable and one isn't),
                        // but the typical case is
                        // "all-zero" and we save
                        // them 5 clicks.
                        const newItems = form.items.map(it => ({ ...it, vatRate: 0 }))
                        setForm({ ...form, reverseCharge: true, euTransaction: false, items: newItems })
                      }}
                      data-testid="invoice-tax-reverse-charge"
                    />
                    {t("invoice.taxTreatmentReverseCharge")}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="taxTreatment"
                      value="euTransaction"
                      checked={form.euTransaction}
                      onChange={() => {
                        // Same — IgE → 0% VAT.
                        const newItems = form.items.map(it => ({ ...it, vatRate: 0 }))
                        setForm({ ...form, reverseCharge: false, euTransaction: true, items: newItems })
                      }}
                      data-testid="invoice-tax-eu"
                    />
                    {t("invoice.taxTreatmentEu")}
                  </label>
                </div>
                <p className="text-xs text-gray-600 mt-2">
                  {t("invoice.taxTreatmentHelp")}
                </p>
                {/* Contextual help: §-reference for
                    the active selection, plus the
                    VAT-ID warning for IgE. We use
                    inline classes so the styling
                    matches the rest of the form
                    (no Tailwind config needed). */}
                {form.reverseCharge && (
                  <p className="text-xs text-amber-700 mt-2" data-testid="invoice-tax-reverse-charge-help">
                    {t("invoice.taxTreatmentReverseChargeHelp")}
                  </p>
                )}
                {form.euTransaction && (() => {
                  // The customer picker stores the
                  // selected Customer in customers[]
                  // (already loaded at mount). Find
                  // the match and check vatId.
                  const sel = customers.find(c => c.id === form.customerId)
                  const vatIdMissing = !sel?.vatId
                  return (
                    <>
                      <p className="text-xs text-amber-700 mt-2" data-testid="invoice-tax-eu-help">
                        {t("invoice.taxTreatmentEuHelp")}
                      </p>
                      {vatIdMissing && (
                        <p className="text-xs text-red-700 mt-1" data-testid="invoice-tax-eu-vatid-missing">
                          {t("invoice.taxTreatmentVatIdMissing")}
                        </p>
                      )}
                    </>
                  )
                })()}
              </div>

              {/* Liefertermin (delivery date) — optional, shown on
                  the PDF when set. Fälligkeitsdatum is intentionally
                  not editable here: it is auto-computed from the
                  Zahlungsziel dropdown at the top of this section
                  and stored when the invoice is created. The user
                  can override per-invoice on the detail page if
                  they really need to. */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.deliveryDate")}
                  </label>
                  <Input
                    type="date"
                    value={form.deliveryDate}
                    onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })}
                    title={t("invoice.deliveryDateHint")}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Template Selection Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("template.label")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div
                  className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                    templateType === "standard"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray dark:border-gray-700-200 dark:border-gray-700 hover:border-blue-300 dark:border-blue-700"
                  }`}
                  onClick={() => setTemplateType("standard")}
                >
                  <div className="font-medium text-sm mb-1">
                    {t("template.standard")}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t("template.standardDesc")}
                  </div>
                </div>
                <div
                  className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                    templateType === "simplified"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray dark:border-gray-700-200 dark:border-gray-700 hover:border-blue-300 dark:border-blue-700"
                  }`}
                  onClick={() => setTemplateType("simplified")}
                >
                  <div className="font-medium text-sm mb-1">
                    {t("template.simplified")}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t("template.simplifiedDesc")}
                  </div>
                </div>
                <div
                  className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
                    templateType === "compact"
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray dark:border-gray-700-200 dark:border-gray-700 hover:border-blue-300 dark:border-blue-700"
                  }`}
                  onClick={() => setTemplateType("compact")}
                >
                  <div className="font-medium text-sm mb-1">
                    {t("template.compact")}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t("template.compactDesc")}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Line Items Card. The "+" add button used to live
              here in the CardHeader, but the user asked for
              it to be moved into the per-row actions column
              (right of the "Remove" button) so each row has
              both controls. Clicking "+" on a row inserts a
              new empty row directly below it. */}
          <Card>
            <CardHeader>
              <CardTitle>{t("invoice.items")}</CardTitle>
            </CardHeader>
            {invoiceType === "CN" && form.referenceInvoiceId && (
              <div className="px-6 pb-2 text-xs text-amber-700 bg-amber-50 border-t border-amber-100 -mt-2 pt-2">
                ℹ️ {t("common2.creditNoteItemsHint")}
              </div>
            )}
            <CardContent className="space-y-4">
              {/* Header row mirrors the per-row column
                  distribution: 2 productNo | 4 desc | 2
                  qty+unit | 1 price | 1 vat | 1 remove | 1
                  add. The "Remove" / "Add" header cells
                  have no label (the icons in the rows are
                  self-explanatory) but keep the columns
                  aligned with the rows below. */}
              <div className="grid grid-cols-12 gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 px-2">
                <div className="col-span-2">{t("invoice.productNumber")}</div>
                <div className="col-span-4">{t("invoice.description")}</div>
                <div className="col-span-2">{t("invoice.quantity")}</div>
                <div className="col-span-1">{t("invoice.unitPrice")} (€)</div>
                <div className="col-span-1">{t("invoice.vatRate")}</div>
                <div className="col-span-1"></div>
                <div className="col-span-1"></div>
              </div>
              {form.items.map((item, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-2 relative">
                    {/* Artikelnr. / SKU with a product search
                        dropdown. Typing here opens a list of
                        matching products (filtered by name or
                        SKU). Click a result to fill the whole
                        line item, same as the description picker.
                        If 0 products match, a "Create new
                        product" link appears at the bottom of
                        the dropdown to add a new product
                        without leaving the invoice. */}
                    <Input
                      value={item.productNumber || ""}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].productNumber = e.target.value
                        setForm({ ...form, items })
                        // Trigger the search dropdown. We use
                        // the SKU text as the search string —
                        // filteredProducts already matches by
                        // name OR sku.
                        setProductNumberSearch(e.target.value)
                        setShowProductNumberDropdown(e.target.value.trim().length > 0)
                        setActiveItemIndex(index)
                        // Close the description-triggered
                        // dropdown to avoid two competing
                        // pickers on the same row.
                        setShowProductDropdown(false)
                      }}
                      onFocus={() => {
                        // Show dropdown if there's already a
                        // value (so the user can refine an
                        // existing SKU). Don't auto-clear it.
                        if ((item.productNumber || "").trim().length > 0) {
                          setProductNumberSearch(item.productNumber || "")
                          setShowProductNumberDropdown(true)
                          setActiveItemIndex(index)
                        }
                      }}
                      onBlur={() => {
                        // Delay close so a click on a dropdown
                        // item (which fires after blur) still
                        // registers. 200ms is the standard
                        // "let the click happen" delay.
                        setTimeout(() => setShowProductNumberDropdown(false), 200)
                      }}
                      placeholder={t("invoice.productNumber")}
                      title={t("invoice.productNumberSearchHint")}
                      className="font-mono text-sm"
                    />
                    {showProductNumberDropdown && activeItemIndex === index && productNumberSearch && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg max-h-56 overflow-y-auto z-20">
                        {(() => {
                          // Filter by SKU first (exact prefix
                          // match) then by name. The user is
                          // typing into a SKU field, so
                          // SKU-prefix matches are most
                          // relevant.
                          const q = productNumberSearch.trim().toLowerCase()
                          const matches = products.filter(p =>
                            (p.sku && p.sku.toLowerCase().includes(q)) ||
                            (p.name && p.name.toLowerCase().includes(q))
                          ).slice(0, 5)
                          if (matches.length === 0) {
                            return (
                              <>
                                <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-sm border-b">
                                  {t("errors.noProductsFound")}
                                </div>
                                {/* No match: offer to create a
                                    new product with the typed
                                    SKU. Pre-filled with the
                                    SKU; user can edit before
                                    saving. */}
                                <div
                                  className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-blue-700 dark:text-blue-300 text-sm font-medium border-t"
                                  onMouseDown={(e) => {
                                    // Use onMouseDown so the
                                    // click fires BEFORE the
                                    // input's blur handler
                                    // closes the dropdown.
                                    e.preventDefault()
                                    openNewProductModal(index)
                                  }}
                                >
                                  + {t("invoice.createNewProductWithSku").replace("{sku}", productNumberSearch.trim() || "")}
                                </div>
                              </>
                            )
                          }
                          return matches.map((p) => (
                            <div
                              key={p.id}
                              className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                              onMouseDown={(e) => {
                                e.preventDefault()
                                selectProduct(p, index)
                              }}
                            >
                              <div className="font-medium text-sm">{p.name}</div>
                              <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                {p.sku && `${p.sku} · `}€{parseFloat(p.basePrice).toFixed(2)}
                              </div>
                            </div>
                          ))
                        })()}
                      </div>
                    )}
                  </div>
                  <div className="col-span-4 relative">
                    <Input
                      value={item.description}
                      data-testid="item-description"
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].description = e.target.value
                        items[index].productId = undefined
                        setForm({ ...form, items })
                        setProductSearch(e.target.value)
                        setShowProductDropdown(e.target.value.length > 0)
                        setActiveItemIndex(index)
                      }}
                      onFocus={() => {
                        setActiveItemIndex(index)
                        setShowProductDropdown(item.description.length > 0)
                      }}
                      placeholder={t("common2.productSearch")}
                    />
                    {showProductDropdown && activeItemIndex === index && productSearch && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg max-h-40 overflow-y-auto z-10">
                        {filteredProducts.length === 0 ? (
                          <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-sm">{t("errors.noProductsFound")}</div>
                        ) : (
                          filteredProducts.slice(0, 5).map((p) => (
                            <div
                              key={p.id}
                              className="px-3 py-2 hover:bg-blue-50 cursor-pointer"
                              onClick={() => selectProduct(p, index)}
                            >
                              <div className="font-medium text-sm">{p.name}</div>
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                {p.sku && `${p.sku} · `}€{parseFloat(p.basePrice).toFixed(2)}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <div className="col-span-2 flex gap-1">
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      className="w-16"
                      data-testid="item-quantity"
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].quantity = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    />
                    <Input
                      value={item.unit}
                      className="w-16"
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].unit = e.target.value
                        setForm({ ...form, items })
                      }}
                    />
                  </div>
                  <div className="col-span-2">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={item.unitPrice}
                      data-testid="item-unit-price"
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].unitPrice = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    />
                  </div>
                  <div className="col-span-1">
                    <select
                      className="w-full h-10 border rounded-md px-1 text-sm"
                      value={item.vatRate}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[index].vatRate = Number(e.target.value)
                        setForm({ ...form, items })
                      }}
                    >
                      <option value={0.19}>19%</option>
                      <option value={0.07}>7%</option>
                      <option value={0}>0%</option>
                    </select>
                  </div>
                  {/* Per-row "Remove" button \u2014 right of the
                      VAT rate column, 1 col wide. Variant
                      ghost so it doesn't compete visually
                      with the inputs. */}
                  <div className="col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-300 hover:bg-red-50 px-1"
                      onClick={() => {
                        const items = form.items.filter((_, i) => i !== index)
                        setForm({ ...form, items })
                      }}
                      title={t("invoice.removeItem")}
                    >
                      ✕
                    </Button>
                  </div>
                  {/* Per-row "Add" button — right of the
                      Remove button, 1 col wide. Renders
                      ONLY on the LAST row of the items
                      table (per the user's preference —
                      having + on every row was visually
                      noisy and the user just wants one
                      place to add the next row). For all
                      other rows we still render an empty
                      col-span-1 so the grid columns stay
                      aligned across rows. The addItemAt
                      helper accepts the index but the call
                      site always passes the last index, so
                      the "insert below" behavior is
                      effectively the same as "append to
                      end" since the last row's index IS
                      the end. */}
                  <div className="col-span-1">
                    {index === form.items.length - 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:text-blue-300 hover:bg-blue-50 px-1"
                        onClick={() => addItemAt(index)}
                        title={t("invoice.addItem")}
                      >
                        +
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Discount Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("invoice.discount")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.discountPercent")}</label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={form.discountPercent}
                    onChange={(e) => setForm({ ...form, discountPercent: Number(e.target.value), discountAmount: 0 })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.discountAmount")} (€)</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.discountAmount}
                    onChange={(e) => setForm({ ...form, discountAmount: Number(e.target.value), discountPercent: 0 })}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Tier 52: Skonto (cash discount for early
              payment). Two side-by-side inputs: a percent
              and a day count. Both set together = "Payable
              within X days with Y% discount". The PDF
              renders the standard German "Zahlbar bis
              DD.MM. mit X% Skonto, bis DD.MM. ohne Abzug"
              line. The bank-import auto-recognises the
              discount when the customer pays within the
              window. */}
          <Card data-testid="skonto-card">
            <CardHeader>
              <CardTitle>{t("invoice.skonto") || "Skonto"}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                {t("invoice.skontoHint") ||
                  "Optionaler Barzahlungsrabatt für vorzeitige Zahlung. Beispiel: 2% Skonto bei Zahlung innerhalb 14 Tagen."}
              </p>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.skontoPercent") || "Skonto %"}
                  </label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={form.skontoPercent}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        skontoPercent: Number(e.target.value),
                      })
                    }
                    data-testid="skonto-percent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("invoice.skontoDays") || "Tage"}
                  </label>
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    max="365"
                    value={form.skontoDays}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        skontoDays: Number(e.target.value),
                      })
                    }
                    data-testid="skonto-days"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Payment Info Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("common2.paymentInfo")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("invoice.paymentMethod")}</label>
                  <select
                    className="w-full h-10 border rounded-md px-3"
                    value={form.paymentMethod}
                    onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
                  >
                    <option value="bank_transfer">{t("paymentMethod.bankTransfer")}</option>
                    <option value="cash">{t("paymentMethod.cash")}</option>
                    <option value="ec_card">EC-Karte</option>
                    <option value="credit_card">{t("paymentMethod.creditCard")}</option>
                    <option value="paypal">PayPal</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-end gap-2 mb-1">
                    <label className="block text-sm font-medium flex-1">{t("invoice.notes")}</label>
                    {/* Tier 156: pick a saved Bemerkungstext
                        and append it to the notes field.
                        The selected template's text is
                        rendered with placeholders first
                        ({{customerName}}, {{total}},
                        {{dueDate}}, {{invoiceNumber}},
                        {{companyName}}) so the operator
                        sees the final wording before
                        saving. Unknown placeholders stay
                        literal so the operator notices
                        when the context is missing. */}
                    {noteTemplates.length > 0 && (
                      <select
                        data-testid="invoice-notes-template-select"
                        value=""
                        onChange={(e) => {
                          const id = e.target.value
                          if (!id) return
                          const tpl = noteTemplates.find((t) => t.id === id)
                          if (!tpl) return
                          // Substitute known placeholders
                          // with the current form state.
                          // The customer name + total +
                          // dueDate are the most useful;
                          // the operator can edit the
                          // resulting text in the field
                          // before saving.
                          const customer = customers.find(
                            (c) => c.id === form.customerId,
                          )
                          const total = calculateTotal()
                          const totalStr = total
                            ? new Intl.NumberFormat("de-DE", {
                                style: "currency",
                                currency: form.currency || "EUR",
                              }).format(total)
                            : "{{total}}"
                          const dueDateStr = form.dueDate
                            ? new Date(form.dueDate).toLocaleDateString("de-DE")
                            : "{{dueDate}}"
                          const rendered = tpl.text
                            .replace(/\{\{customerName\}\}/g, customer?.name || "{{customerName}}")
                            .replace(/\{\{total\}\}/g, totalStr)
                            .replace(/\{\{dueDate\}\}/g, dueDateStr)
                            .replace(/\{\{invoiceNumber\}\}/g, "{{invoiceNumber}}")
                            .replace(/\{\{companyName\}\}/g, "{{companyName}}")
                          // Append with a newline separator
                          // (so the operator can keep
                          // multiple snippets stacked).
                          const next = form.notes
                            ? `${form.notes}\n${rendered}`
                            : rendered
                          setForm({ ...form, notes: next })
                          // Reset the select so picking the
                          // same template twice in a row
                          // still fires onChange.
                          e.target.value = ""
                        }}
                        className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 max-w-[220px]"
                      >
                        <option value="">
                          {t("invoiceNotes.insertTemplate") || "+ Vorlage einfügen"}
                        </option>
                        {noteTemplates.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <a
                      href="/dashboard/settings/note-templates"
                      data-testid="invoice-notes-manage-link"
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                      title={t("invoiceNotes.manageTitle") || "Vorlagen verwalten"}
                    >
                      ⚙ {t("invoiceNotes.manage") || "Verwalten"}
                    </a>
                  </div>
                  <Input
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder={t("common2.additionalNotes")}
                    data-testid="invoice-notes-input"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Summary Card — shows amounts in the SELECTED
              currency (form.currency). For non-EUR the user
              sees the original-currency total on the PDF /
              XRechnung; the EUR equivalent is computed at
              save time and stored on the row for aggregation. */}
          <Card className="bg-gray-50 dark:bg-gray-900">
            <CardHeader>
              <CardTitle>{t("common2.summary")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-300">{t("invoice.subtotal")} ({t("common2.net")}):</span>
                <span data-testid="summary-subtotal">{fmtCurrency(calculateSubtotal(), form.currency)}</span>
              </div>
              {calculateDiscount() > 0 && (
                <div className="flex justify-between text-green-600 dark:text-green-400">
                  <span>{t("invoice.discount")}:</span>
                  <span>-{fmtCurrency(calculateDiscount(), form.currency)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-300">{t("invoice.vat")}:</span>
                <span data-testid="summary-vat">{fmtCurrency(calculateVat(), form.currency)}</span>
              </div>
              <div className="flex justify-between text-xl font-bold border-t pt-3">
                <span>{t("common2.totalGross")}:</span>
                <span className="text-blue-600 dark:text-blue-400" data-testid="summary-total">{fmtCurrency(calculateTotal(), form.currency)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Submit — two actions:
                "Erstellen"   — save + navigate to detail/list
                "Erstellen & Drucken" — save + open the PDF in a
                  new tab and fire window.print() so the user
                  lands in the system print dialog. Faster B2B
                  workflow where most invoices go straight to
                  the printer. In edit mode only "Save changes"
                  shows (reprinting is one click away on the
                  detail page). */}
          <div className="flex gap-4">
            <Button type="submit" className="flex-1" disabled={loading || !!loadError}>
              {loading
                ? (t("common.saving") || "Wird gespeichert...")
                : isEdit
                  ? (t("invoice.saveChanges") || "Änderungen speichern")
                  : t("invoice.createInvoice")}
            </Button>
            {!isEdit && (
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={loading || !!loadError}
                onClick={handleSaveAndPrint}
              >
                {t("invoice.createAndPrint") || "Erstellen & Drucken"}
              </Button>
            )}
          </div>
        </form>
      </div>

      {/* "Create new product" modal. Shown when the user
          clicks the "Create new product ..." link in the
          product-number dropdown. The field set mirrors the
          products page's create/edit form 1:1 so the user
          can fill in everything they need without having to
          come back later to add inventory / description /
          type etc. on the products page. POSTs to
          /api/v1/products on save and auto-selects the new
          product for the originating line item. The overlay
          uses a semi-transparent black layer so the
          underlying invoice form is dimmed but still
          visible (helps the user keep their place). */}
      {newProductModal?.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !newProductModal.loading && setNewProductModal(null)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <Card>
              <CardHeader>
                <CardTitle>{t("invoice.newProductModalTitle")}</CardTitle>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t("invoice.createNewProductWithSku").replace("{sku}", newProductModal.sku || "—")}
                </p>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    createProductFromSku()
                  }}
                  className="space-y-4"
                >
                  {/* Name — required. Mirrors the products form's
                      first field. Autofocus so the user can start
                      typing immediately. Enter on this field (or
                      on any field below) submits the form. */}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("product.name")} *</label>
                    <Input
                      autoFocus
                      value={newProductModal.name}
                      onChange={(e) => setNewProductModal({ ...newProductModal, name: e.target.value })}
                      placeholder="z.B. Beratungsleistung"
                      required
                    />
                  </div>
                  {/* Description — optional, same as products form. */}
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {t("product.description") || "Beschreibung"}
                    </label>
                    <Input
                      value={newProductModal.description}
                      onChange={(e) => setNewProductModal({ ...newProductModal, description: e.target.value })}
                      placeholder="Optional"
                    />
                  </div>
                  {/* SKU + type — same row layout as products form.
                      SKU is pre-filled from the Artikelnr. input
                      the user typed into. */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.sku")}</label>
                      <Input
                        value={newProductModal.sku}
                        onChange={(e) => setNewProductModal({ ...newProductModal, sku: e.target.value })}
                        placeholder="PRD-001"
                        className="font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.type")}</label>
                      <select
                        className="w-full h-10 border rounded-md px-3"
                        value={newProductModal.type}
                        onChange={(e) => setNewProductModal({ ...newProductModal, type: e.target.value as "good" | "service" })}
                      >
                        <option value="good">{t("product.typeGood")}</option>
                        <option value="service">{t("product.typeService")}</option>
                      </select>
                    </div>
                  </div>
                  {/* Unit + price + VAT — 3-col grid matching the
                      products form. basePrice is required. */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.unit")}</label>
                      <Input
                        value={newProductModal.unit}
                        onChange={(e) => setNewProductModal({ ...newProductModal, unit: e.target.value })}
                        placeholder="Stück/Stunde/Projekt"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.price")} (€) *</label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={newProductModal.basePrice}
                        onChange={(e) => setNewProductModal({ ...newProductModal, basePrice: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("product.vatRate")}</label>
                      <select
                        className="w-full h-10 border rounded-md px-3"
                        value={newProductModal.vatRate}
                        onChange={(e) => setNewProductModal({ ...newProductModal, vatRate: e.target.value })}
                      >
                        <option value="0.19">19% {t("product.standard")}</option>
                        <option value="0.07">7% {t("product.reduced")}</option>
                        <option value="0">0% {t("product.zero")}</option>
                      </select>
                    </div>
                  </div>

                  {/* Inventory section — same as the products
                      form. Hidden when trackInventory is off
                      (matches the products page behavior). */}
                  <div className="border-t pt-4 mt-4">
                    <h3 className="text-sm font-medium mb-3">{t("inventory.tracking")}</h3>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <p className="font-medium">{t("inventory.trackProduct")}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{t("inventory.trackHint")}</p>
                      </div>
                      <Switch
                        checked={newProductModal.trackInventory}
                        onCheckedChange={(checked) => setNewProductModal({ ...newProductModal, trackInventory: checked })}
                      />
                    </div>
                    {newProductModal.trackInventory && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium mb-1">{t("inventory.currentStock")}</label>
                          <Input
                            type="number"
                            step="0.01"
                            value={newProductModal.stockQuantity}
                            onChange={(e) => setNewProductModal({ ...newProductModal, stockQuantity: e.target.value })}
                            placeholder="0"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">{t("inventory.threshold")}</label>
                          <Input
                            type="number"
                            step="0.01"
                            value={newProductModal.lowStockThreshold}
                            onChange={(e) => setNewProductModal({ ...newProductModal, lowStockThreshold: e.target.value })}
                            placeholder="10"
                          />
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t("inventory.thresholdHint")}</p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setNewProductModal(null)}
                      disabled={newProductModal.loading}
                    >
                      {t("invoice.newProductCancel")}
                    </Button>
                    <Button
                      type="submit"
                      disabled={newProductModal.loading || !newProductModal.name.trim()}
                    >
                      {newProductModal.loading
                        ? (t("common.saving") || "...")
                        : t("invoice.newProductCreate")}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* "Create new customer" modal. Shown when the user
          clicks the "+ Neuen Kunden anlegen" link in the
          customer picker dropdown. The field set mirrors
          the customers page's create/edit form 1:1 (see
          src/app/dashboard/customers/page.tsx) so the user
          can fill in everything they need without having
          to come back later. POSTs to /api/v1/customers on
          save and auto-selects the new customer for the
          invoice. The overlay uses a semi-transparent
          black layer so the underlying invoice form is
          dimmed but still visible. */}
      {newCustomerModal?.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !newCustomerModal.loading && setNewCustomerModal(null)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <Card>
              <CardHeader>
                <CardTitle>{t("invoice.newCustomerModalTitle")}</CardTitle>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {t("invoice.createNewCustomerWithName").replace("{name}", newCustomerModal.name || "—")}
                </p>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    createCustomerFromName()
                  }}
                  className="space-y-4"
                >
                  {/* Name — required. Mirrors the customers form's
                      first field. Autofocus so the user can
                      start typing immediately. Enter on any
                      field submits. */}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.name")} *</label>
                    <Input
                      autoFocus
                      value={newCustomerModal.name}
                      onChange={(e) => setNewCustomerModal({ ...newCustomerModal, name: e.target.value })}
                      placeholder={t("settings.placeholderCompanyName") || "z.B. Muster GmbH"}
                      required
                    />
                  </div>
                  {/* VAT ID + type — same row layout as the
                      customers form. */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("customer.vatId")}</label>
                      <Input
                        value={newCustomerModal.vatId}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, vatId: e.target.value })}
                        placeholder="DE123456789"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("customer.type")}</label>
                      <select
                        className="w-full h-10 border rounded-md px-3"
                        value={newCustomerModal.type}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, type: e.target.value as "business" | "individual" })}
                      >
                        <option value="business">{t("customer.typeBusiness")}</option>
                        <option value="individual">{t("customer.typePrivate")}</option>
                      </select>
                    </div>
                  </div>
                  {/* Street — full row. */}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.street")}</label>
                    <Input
                      value={newCustomerModal.street}
                      onChange={(e) => setNewCustomerModal({ ...newCustomerModal, street: e.target.value })}
                      placeholder="Musterstraße 123"
                    />
                  </div>
                  {/* Postal code + city — 3-col grid, postal
                      code 1, city 2 (matches the customers
                      form's layout). */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("customer.postalCode")}</label>
                      <Input
                        value={newCustomerModal.postalCode}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, postalCode: e.target.value })}
                        placeholder="12345"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium mb-1">{t("customer.city")}</label>
                      <Input
                        value={newCustomerModal.city}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, city: e.target.value })}
                        placeholder={t("settings.placeholderCity") || "Berlin"}
                      />
                    </div>
                  </div>
                  {/* Country — full row. Default "DE" so the
                      customer has at least a country set on
                      creation. */}
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("customer.country")}</label>
                    <Input
                      value={newCustomerModal.country}
                      onChange={(e) => setNewCustomerModal({ ...newCustomerModal, country: e.target.value })}
                      placeholder={t("customer.countryPlaceholder") || "z.B. Deutschland"}
                    />
                  </div>
                  {/* taxExempt + paymentTerms — side-by-side,
                      same as the customers form. */}
                  <div className="grid grid-cols-2 gap-4">
                    <label className="flex items-center gap-2 text-sm h-10">
                      <input
                        type="checkbox"
                        checked={newCustomerModal.taxExempt}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, taxExempt: e.target.checked })}
                        className="w-4 h-4"
                      />
                      {t("customer.taxExempt") || "Steuerbefreit"}
                    </label>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("customer.paymentTerms")}</label>
                      <select
                        className="w-full h-10 border rounded-md px-3"
                        value={newCustomerModal.paymentTerms}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, paymentTerms: Number(e.target.value) })}
                      >
                        <option value={0}>{t("paymentTerm.immediate")}</option>
                        <option value={7}>{t("paymentTerm.days7")}</option>
                        <option value={14}>{t("paymentTerm.days14")}</option>
                        <option value={30}>{t("paymentTerm.days30")}</option>
                        <option value={60}>{t("paymentTerm.days60")}</option>
                      </select>
                    </div>
                  </div>
                  {/* Email + phone — 2-col grid, same as the
                      customers form. */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("customer.email")}</label>
                      <Input
                        type="email"
                        value={newCustomerModal.email}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, email: e.target.value })}
                        placeholder="info@example.de"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">{t("customer.phone")}</label>
                      <Input
                        value={newCustomerModal.phone}
                        onChange={(e) => setNewCustomerModal({ ...newCustomerModal, phone: e.target.value })}
                        placeholder="+49 123 456789"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setNewCustomerModal(null)}
                      disabled={newCustomerModal.loading}
                    >
                      {t("invoice.newCustomerCancel")}
                    </Button>
                    <Button
                      type="submit"
                      disabled={newCustomerModal.loading || !newCustomerModal.name.trim()}
                    >
                      {newCustomerModal.loading
                        ? (t("common.saving") || "...")
                        : t("invoice.newCustomerCreate")}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </main>
  )
}
export default function CreateInvoicePage() {
  return (
    <Suspense fallback={null}>
      <CreateInvoicePageInner />
    </Suspense>
  )
}