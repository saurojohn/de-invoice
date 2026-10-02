import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common'
import { Require } from '../../auth/roles.decorator'
import { CompanyCarService } from './company-car.service'
import { CreateCompanyCarDto, EndCompanyCarDto } from './company-car.dto'

/** Tier 502 — company cars used privately (1 % rule). */
@Controller('company-cars')
export class CompanyCarController {
  constructor(private cars: CompanyCarService) {}

  @Get()
  @Require('company.read')
  list(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.cars.list(companyId)
  }

  @Get('private-use')
  @Require('company.read')
  privateUse(@Query('companyId') companyId: string, @Query('year') year: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const y = parseInt(year, 10)
    if (!y || y < 2000 || y > 2100) throw new BadRequestException('year is required')
    return this.cars.yearSummary(companyId, y)
  }

  @Post()
  @Require('company.update')
  create(@Query('companyId') companyId: string, @Body() body: CreateCompanyCarDto) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.cars.create(companyId, body)
  }

  @Put(':id')
  @Require('company.update')
  end(@Query('companyId') companyId: string, @Param('id') id: string, @Body() body: EndCompanyCarDto) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.cars.end(companyId, id, body)
  }

  @Delete(':id')
  @Require('company.update')
  remove(@Query('companyId') companyId: string, @Param('id') id: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.cars.remove(companyId, id)
  }
}
