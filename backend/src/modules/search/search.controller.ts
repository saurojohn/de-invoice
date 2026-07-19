import { Controller, Get, Query, BadRequestException } from '@nestjs/common'
import { SearchService } from './search.service'
import { Auth } from '../../auth/roles.decorator'

/**
 * Tier 28: search controller.
 *
 * The frontend (customers/products/invoices list pages)
 * hits these endpoints when the user types into the
 * search bar. The endpoint returns a small JSON with
 *   - rank (ts_rank, higher = better hit)
 *   - snippet (the matched field with <mark>...</mark>
 *     around the hit positions)
 *   - row (the bare-bones row data so the UI can render
 *     a hit preview without a second round-trip)
 *
 * Why three endpoints instead of one:
 *   - Each entity has different row shape and different
 *     default sort order (invoices by date, products
 *     by name, customers by name).
 *   - The frontend drives separate search inputs per
 *     list page; a combined endpoint would need a
 *     "type" param and result-shape polymorphism.
 *
 * Auth: HeaderAuthGuard enforces the standard x-user-id
 * + x-company-id header set; the companyId is also
 * passed as a query param for backward compat with the
 * existing list endpoints that use ?companyId=.
 */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Auth()
  @Get('customers')
  async searchCustomers(
    @Query('companyId') companyId: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    return this.search.searchCustomers(companyId, q ?? '', {
      limit: limit ? parseInt(limit, 10) : undefined,
    })
  }

  @Auth()
  @Get('products')
  async searchProducts(
    @Query('companyId') companyId: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    return this.search.searchProducts(companyId, q ?? '', {
      limit: limit ? parseInt(limit, 10) : undefined,
    })
  }

  @Auth()
  @Get('invoices')
  async searchInvoices(
    @Query('companyId') companyId: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    return this.search.searchInvoices(companyId, q ?? '', {
      limit: limit ? parseInt(limit, 10) : undefined,
    })
  }

  /**
   * Tier 68: cross-entity global search for the
   * ⌘K command bar. Returns hits grouped by type
   * (customer / product / invoice), each group
   * capped at `limit` (default 5, max 20).
   *
   * Why no @Require(): the global search bar is for
   * every logged-in user (the dropdown shows on
   * every dashboard page). The existing
   * HeaderAuthGuard + per-entity permission checks
   * inside the service handle authorization — a
   * user with no customer.read can still call this
   * endpoint and get an empty customer group.
   *
   * Throttling: the global search fires on every
   * keystroke (debounced 200ms client-side). A
   * 600/60s global throttler is plenty — even
   * typing at 200wpm is 8 keys/sec × 60s = 480
   * requests/minute, just under the cap.
   */
  @Auth()
  @Get('global')
  async globalSearch(
    @Query('companyId') companyId: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    let parsedLimit: number | undefined
    if (limit) {
      const n = parseInt(limit, 10)
      if (Number.isNaN(n) || n < 1 || n > 20) {
        throw new BadRequestException('Ungültiger limit (1-20)')
      }
      parsedLimit = n
    }
    return this.search.globalSearch(companyId, q ?? '', {
      limit: parsedLimit,
    })
  }
}