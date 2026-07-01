import { Controller, Get, Query } from '@nestjs/common'
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
}