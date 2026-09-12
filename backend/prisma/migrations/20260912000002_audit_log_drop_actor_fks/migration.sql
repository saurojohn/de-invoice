-- Tier 368: drop the AuditLog -> User / Company foreign keys.
--
-- Both were ON DELETE SET NULL, so deleting a user made PostgreSQL silently
-- rewrite `userId` on every audit row that user had ever produced — including
-- rows that were already SIGNED. The hash is computed over userId/companyId at
-- write time, so the rewrite left the stored hash describing a row that no
-- longer exists, and the chain broke with hash_mismatch through no fault of
-- anyone tampering.
--
-- Measured on a throwaway stack: 4 signed rows in that state, e.g. a
-- `login_success` whose entityId still held `user-2fa-test-...` (entityId has
-- no FK, so it survived) while userId had been nulled and the user was gone.
-- It is not specific to the auth rows migrated in this tier — an
-- `invoice.updated` row written by the audit extension was in the same state;
-- those rows were simply unsigned before, so verifyChain skipped them.
--
-- An audit record must not change when the data it describes is deleted; that
-- is the whole point of a GoBD trail. userId/companyId therefore become plain
-- string snapshots of who acted, pointing at ids that may no longer resolve.
-- Queries that need the e-mail look it up separately (see audit.service.ts) —
-- the two raw-SQL paths already used a manual LEFT JOIN, which needs no FK.

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_companyId_fkey";
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey";
