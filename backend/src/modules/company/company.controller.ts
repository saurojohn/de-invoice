import { Controller, Get, Put, Post, Body, Param, UseInterceptors, UploadedFile } from '@nestjs/common';
import { CompanyService } from './company.service';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { Auth, Require } from '../../auth/roles.decorator';
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

  @Post('upload-logo')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  }))
  async uploadLogo(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      return { error: 'No file uploaded' };
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return { error: 'Invalid file type' };
    }

    // Create filename with company prefix and timestamp
    const ext = path.extname(file.originalname);
    const filename = `logo${ext}`;
    const uploadDir = path.join(process.cwd(), 'frontend', 'public', 'images');

    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Save file
    const filepath = path.join(uploadDir, filename);
    fs.writeFileSync(filepath, file.buffer);

    return { filename };
  }
}
