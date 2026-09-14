import { SetMetadata } from '@nestjs/common'

/**
 * Tier 375 — authentication is default-deny.
 *
 * HeaderAuthGuard is registered as a global APP_GUARD, so every route needs
 * x-user-id / x-company-id unless it is explicitly marked @Public(). Before
 * this, a route was only protected if someone remembered @Auth() or
 * @UseGuards(HeaderAuthGuard): 49 of 449 routes had neither, among them the
 * voucher and chart-of-accounts routes, PUT /mail/config and the inventory
 * adjust route — all reachable with no credentials at all.
 *
 * Only use this for routes that must work before login or that authenticate
 * themselves (a portal token, an invitation token). e2e spec 176 pins the
 * exact list, so adding a public route means updating that spec on purpose.
 */
export const IS_PUBLIC_KEY = 'auth:public'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

/**
 * Tier 375 — HeaderAuthGuard binds `companyId` in the path, query string and
 * JSON body to the authenticated x-company-id. A handler whose `companyId`
 * parameter deliberately names a DIFFERENT company (switching the active
 * Mandant) opts out with this, and must check the grant itself.
 */
export const ALLOW_OTHER_COMPANY_ID_KEY = 'auth:allow-other-company-id'
export const AllowOtherCompanyId = () => SetMetadata(ALLOW_OTHER_COMPANY_ID_KEY, true)
