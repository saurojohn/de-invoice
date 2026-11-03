-- Tier 787: reset and invitation tokens are stored as their SHA-256 and found
-- by it. A link issued before this (a bcrypt hash) no longer matches: a reset
-- lasts an hour, an invitation is sent again from the user list.
CREATE UNIQUE INDEX "User_passwordResetToken_key" ON "User"("passwordResetToken");
CREATE UNIQUE INDEX "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");
