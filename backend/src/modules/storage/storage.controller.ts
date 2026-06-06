import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  Header,
} from '@nestjs/common';
import { Response } from 'express';
import { StorageService } from './storage.service';
import { StorageConfigDto, UploadFileDto } from './dto/storage-config.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { Auth, Require } from '../../auth/roles.decorator';

// Define Multer file type
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
  destination?: string;
  filename?: string;
  path?: string;
}

@Auth()
@Controller('storage')
export class StorageController {
  constructor(private storageService: StorageService) {}

  /**
   * Upload file to local storage
   * POST /api/v1/storage/upload
   */
  @Post('upload')
  @Require('company.update')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  }))
  async uploadFile(
    @UploadedFile() file: MulterFile,
    @Body() dto: UploadFileDto,
  ) {
    if (!file) {
      throw new BadRequestException('Keine Datei hochgeladen.');
    }

    const savedFile = await this.storageService.saveFile(
      file.buffer,
      file.originalname,
      dto.type || 'attachments',
      dto.companyId || 'default',
    );

    return {
      success: true,
      file: savedFile,
    };
  }

  /**
   * Get file from storage
   * GET /api/v1/storage/files/<path>
   */
  @Get('files/*splat')
  @Header('Cache-Control', 'public, max-age=31536000')
  async getFile(@Param('splat') splat: string[], @Res() res: Response) {
    // Convert path parts back to a slash-joined path
    const filePath = (Array.isArray(splat) ? splat.join('/') : splat || '').replace(/,/g, '/');

    const file = await this.storageService.getFile(filePath);

    if (!file) {
      throw new NotFoundException('Datei nicht gefunden.');
    }

    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': file.buffer.length,
      'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
    });

    res.end(file.buffer);
  }

  /**
   * Delete file from storage
   * DELETE /api/v1/storage/files/<path>
   */
  @Delete('files/*splat')
  async deleteFile(@Param('splat') splat: string[]) {
    const filePath = (Array.isArray(splat) ? splat.join('/') : splat || '').replace(/,/g, '/');

    const deleted = await this.storageService.deleteFile(filePath);

    if (!deleted) {
      throw new NotFoundException('Datei nicht gefunden oder bereits gelöscht.');
    }

    return {
      success: true,
      message: 'Datei erfolgreich gelöscht.',
    };
  }

  /**
   * Get storage configuration
   * GET /api/v1/storage/config
   */
  @Get('config')
  @Require('company.update')
  async getConfig() {
    const config = this.storageService.getConfig();
    return {
      localPath: config.localPath,
      cloudEnabled: config.cloudEnabled,
      cloudProvider: config.cloudProvider,
    };
  }

  /**
   * Update storage configuration
   * PUT /api/v1/storage/config
   */
  @Post('config')
  @Require('company.update')
  async updateConfig(@Body() dto: StorageConfigDto) {
    this.storageService.updateConfig(dto);
    return {
      success: true,
      message: 'Speicherkonfiguration aktualisiert.',
    };
  }

  /**
   * Get storage statistics for a company
   * GET /api/v1/storage/stats?companyId=xxx
   */
  @Get('stats')
  @Require('company.update')
  async getStats(@Query('companyId') companyId: string) {
    const stats = await this.storageService.getStorageStats(companyId);

    return {
      totalFiles: stats.totalFiles,
      totalSize: stats.totalSize,
      totalSizeFormatted: this.formatBytes(stats.totalSize),
      usageByType: stats.usageByType,
    };
  }

  /**
   * List all files for a company
   * GET /api/v1/storage/list?companyId=xxx
   */
  @Get('list')
  @Require('company.update')
  async listFiles(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.storageService.listFiles(companyId)
  }

  /**
   * Health check for the storage backend
   * GET /api/v1/storage/health
   */
  @Get('health')
  @Require('company.update')
  async getHealth() {
    const health = await this.storageService.getHealth()
    return {
      ...health,
      freeBytesFormatted: health.freeBytes !== undefined ? this.formatBytes(health.freeBytes) : undefined,
    }
  }

  /**
   * Format bytes to human readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}