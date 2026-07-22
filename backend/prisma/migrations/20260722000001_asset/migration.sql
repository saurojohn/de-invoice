-- Tier 83: Anlagenverzeichnis (Asset Register) + AfA.
--
-- Adds the Asset model for tracking Sachanlagen
-- (fixed assets) per § 266 HGB Anlagevermögen
-- (Aktiva A. 0100-0500) + the § 275 HGB G+V
-- Abschreibungen (Pos 7a) on the income
-- statement.
--
-- Linear AfA only in v1 (geometric / degressive
-- is rare in HGB and would need a separate
-- `afaMethode='geometric'` branch). The AfA
-- computation is in-memory in the AfaService
-- (Buchwert + annual AfA at any point in time),
-- no separate DepreciationEntry table — the
-- Expense rows ARE the postings (the user
-- creates them from the Anlagenverzeichnis
-- page or the system can auto-post).
--
-- v2 work (not in scope):
--   - AfA-Buch (separate journal) for partial-
--     year disposals
--   - Geometric / degressive AfA
--   - Außerplanmäßige Abschreibungen (§ 253
--     Abs. 3 HGB) — impairment
--   - Zuschreibungen (reversal of impairment)
--   - Component approach (§ 253 Abs. 1 HGB
--     sentence 2) — large assets split by
--     component with different ND

CREATE TABLE "Asset" (
  "id" TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "bezeichnung" TEXT NOT NULL,
  "anschaffungsDatum" DATE NOT NULL,
  "anschaffungsKosten" DECIMAL(14,4) NOT NULL,
  "nutzungsdauerMonate" INTEGER NOT NULL,
  "restwert" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "afaMethode" TEXT NOT NULL DEFAULT 'linear',
  "bilanzKonto" TEXT,
  "notiz" TEXT,
  "verkauftAm" DATE,
  "verkaufsPreis" DECIMAL(14,4),
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL,
  CONSTRAINT "Asset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE
);

CREATE INDEX "Asset_companyId_idx" ON "Asset"("companyId");
CREATE INDEX "Asset_companyId_type_idx" ON "Asset"("companyId", "type");
CREATE INDEX "Asset_companyId_anschaffungsDatum_idx" ON "Asset"("companyId", "anschaffungsDatum");
CREATE INDEX "Asset_verkauftAm_idx" ON "Asset"("verkauftAm");
