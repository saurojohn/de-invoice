import { Controller, Get, Put, Post, Body, Param, UseInterceptors, UploadedFile } from '@nestjs/common';
import { CompanyService } from './company.service';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { Auth, Require } from '../../auth/roles.decorator';
import {
  SKR03_DEFAULTS,
  resolveDatevAccounts,
  sanitizeDatevConfig,
  type DatevAccountMap,
} from '../reports/datev.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller('companies')
export class CompanyController {
  constructor(private companyService: CompanyService) {}

  @Auth()
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.companyService.findById(id);
  }

  @Auth()
  @Require('company.update')
  @Put(':id')
  async update(@Param('id') id: string, @Body() data: UpdateCompanyDto) {
    return this.companyService.update(id, data);
  }

  /**
   * Per-company DATEV account map. Returned merged over
   * SKR03_DEFAULTS so the UI can show every field with
   * its current value (override or fallback). The frontend
   * uses this to pre-populate the settings form.
   *
   * The endpoint is @Auth()-protected (header auth, requires
   * the caller to be a member of the company). The
   * per-action permission is not enforced here because the
   * company module doesn't have a 'company.read' action in
   * the permission matrix (only 'company.update' — and we
   * don't want to require admin role just to read the
   * config). Accountants / viewers of the company should be
   * able to see what account map will be used.
   */
  @Auth()
  @Get(':id/datev-config')
  async getDatevConfig(@Param('id') id: string) {
    const company = await this.companyService.findById(id)
    const settings = (company as any)?.settings || {}
    const overrides = sanitizeDatevConfig(settings.datev || {})
    // Return both the merged map (so the UI sees what will
    // actually be used) AND the raw overrides (so the UI
    // can blank out the form for fields the user has not
    // explicitly customised).
    return {
      config: resolveDatevAccounts(overrides),
      overrides,
      defaults: SKR03_DEFAULTS,
    }
  }

  /**
   * Save the per-company DATEV account map. Each account
   * is validated to be a numeric 3-5 digit string; anything
   * else is silently dropped (so the form can be tolerant
   * of partially-filled states). Berater-Nr / Mandanten-Nr
   * are stored here too (5-digit each, zero-padded).
   */
  @Auth()
  @Require('company.update')
  @Put(':id/datev-config')
  async saveDatevConfig(
    @Param('id') id: string,
    @Body() body: { accounts?: Partial<DatevAccountMap>; beraterNr?: string; mandantenNr?: string },
  ) {
    const company = await this.companyService.findById(id)
    const settings = (company as any)?.settings || {}
    const next = { ...settings }
    if (body.accounts) {
      next.datev = sanitizeDatevConfig(body.accounts)
      if (typeof body.beraterNr === 'string' && /^\d{1,5}$/.test(body.beraterNr)) {
        next.datev.beraterNr = body.beraterNr.padStart(5, '0')
      }
      if (typeof body.mandantenNr === 'string' && /^\d{1,5}$/.test(body.mandantenNr)) {
        next.datev.mandantenNr = body.mandantenNr.padStart(5, '0')
      }
    }
    await this.companyService.update(id, { settings: next } as any)
    return { ok: true, config: resolveDatevAccounts(next.datev), overrides: next.datev }
  }

  @Auth()
  @Post('upload-logo')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  }))
  async uploadLogo(
    @UploadedFile() file: Express.Multer.File,
    @Body('companyId') companyId: string,
  ) {
    if (!file) {
      return { error: 'No file uploaded' };
    }
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return { error: 'Invalid file type' };
    }

    // Create filename with company prefix and timestamp
    const ext = path.extname(file.originalname);
    const filename = `logo${ext}`;
    // Anchor the upload dir to the source file location, not
    // process.cwd(). The backend is started with
    //   cd backend && npx ts-node src/main.ts
    // so CWD = de-invoice/backend/, and the previous
    //   path.join(process.cwd(), 'frontend', 'public', 'images')
    // landed at backend/frontend/public/images/ — a directory the
    // mkdirSync happily created in the wrong place. The frontend
    // then tried to serve from frontend/public/images/ (the real
    // public dir) and got 404, so the logo "saved" but never
    // rendered. Going up 4 levels from this file's directory
    // reaches the project root, regardless of where the node
    // process was launched.
    const uploadDir = path.resolve(
      __dirname,
      '..', '..', '..', '..',
      'frontend', 'public', 'images',
    );

    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Save file
    const filepath = path.join(uploadDir, filename);
    fs.writeFileSync(filepath, file.buffer);

    // Also persist the logoPath on the company record. Without
    // this, the user had to ALSO click the main "Speichern" button
    // on the company form to commit logoPath to the DB. The file
    // would land on disk, the preview would show, but on reload
    // the GET would return logoPath='' and the logo would vanish.
    // Doing the update here makes upload a one-step operation.
    await this.companyService.update(companyId, { logoPath: filename });

    return { filename, logoPath: filename };
  }
}
