-- Tier 22: AES-256-GCM at-rest encryption for FinTS PIN.
--
-- Real banks need the PLAINTEXT PIN for the DIALOG
-- INIT's HNVSK envelope (HMAC needs the actual key,
-- not a hash). We store an (iv, tag, ciphertext)
-- triple under FINTS_PIN_ENC_KEY (env var, SHA-256 →
-- 32-byte AES key). Without the env var, this field
-- stays NULL and real-mode is unavailable for the
-- connection — the user gets a 400 explaining what
-- to configure.
--
-- Mock-mode connections (the default in dev) leave
-- these columns NULL — they use pinHash instead.

ALTER TABLE "FinTSConnection"
  ADD COLUMN "encryptedPin" TEXT,
  ADD COLUMN "pinIv" TEXT,
  ADD COLUMN "pinTag" TEXT;