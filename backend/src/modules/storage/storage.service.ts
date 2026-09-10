import { Injectable, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface StorageConfig {
  localPath: string;
  cloudEnabled: boolean;
  cloudProvider: 's3' | 'minio' | 'local';
  s3Config?: {
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    endpoint?: string;
  };
}

export interface SavedFile {
  path: string;
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
  url: string;
}

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  usageByType: Record<string, { count: number; size: number }>;
}

@Injectable()
export class StorageService {
  private config: StorageConfig = {
    localPath: this.getDefaultLocalPath(),
    cloudEnabled: false,
    cloudProvider: 'local',
  };

  constructor() {
    this.ensureBaseDir();
  }

  private getDefaultLocalPath(): string {
    // Tier 11: STORAGE_PATH env var overrides
    // the default. Used in production
    // (Docker) where the storage dir is a
    // mounted volume at /data/invoice-system
    // and the user running the process
    // might not have a writable home
    // directory (Debian bookworm-slim
    // images set HOME=/nonexistent for
    // system users). Falls back to the
    // dev-friendly ~/data/invoice-system.
    if (process.env.STORAGE_PATH) {
      return process.env.STORAGE_PATH
    }
    const home = os.homedir();
    return path.join(home, 'data', 'invoice-system');
  }

  private ensureBaseDir(): void {
    if (!fs.existsSync(this.config.localPath)) {
      fs.mkdirSync(this.config.localPath, { recursive: true });
    }
  }

  /**
   * Update storage configuration
   */
  updateConfig(newConfig: Partial<StorageConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.ensureBaseDir();
  }

  /**
   * Get current storage configuration
   */
  getConfig(): StorageConfig {
    return { ...this.config };
  }

  /**
   * Save file to local storage
   * @param buffer - File buffer
   * @param filename - Original filename
   * @param type - File type category (e.g., 'pdf', 'images', 'attachments')
   * @param companyId - Company ID for directory organization
   */
  async saveFile(
    buffer: Buffer,
    filename: string,
    type: string,
    companyId: string,
  ): Promise<SavedFile> {
    // Validate file size (10MB limit)
    const maxSize = 10 * 1024 * 1024;
    if (buffer.length > maxSize) {
      throw new BadRequestException('Datei zu groß. Maximal 10MB erlaubt.');
    }

    // Validate allowed file types

    // For now, accept all buffer uploads (type is determined by extension)
    const ext = path.extname(filename).toLowerCase();
    const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.tif', '.tiff'];

    if (!allowedExtensions.includes(ext)) {
      throw new BadRequestException('Dateityp nicht erlaubt.');
    }

    // Build directory structure: {localPath}/{year}/{month}/{type}/{companyId}/
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');

    const dirPath = path.join(this.config.localPath, year, month, type, companyId);

    // Create directory if it doesn't exist
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const safeFilename = this.sanitizeFilename(filename);
    const newFilename = `${timestamp}_${safeFilename}`;
    const filePath = path.join(dirPath, newFilename);

    // Write file
    fs.writeFileSync(filePath, buffer);

    // Calculate relative path for storage
    const relativePath = path.join(year, month, type, companyId, newFilename);
    const url = `/api/v1/storage/${relativePath.replace(/\\/g, '/')}`;

    return {
      path: relativePath,
      filename: newFilename,
      originalName: filename,
      size: buffer.length,
      mimeType: this.getMimeType(ext),
      url,
    };
  }

  /**
   * Get file from local storage
   * @param relativePath - Relative path of the file
   */
  async getFile(relativePath: string): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
    const fullPath = path.join(this.config.localPath, relativePath);

    // Security check: prevent directory traversal
    if (!this.isPathSafe(fullPath)) {
      return null;
    }

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const buffer = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();

    return {
      buffer,
      mimeType: this.getMimeType(ext),
      filename: path.basename(fullPath),
    };
  }

  /**
   * Delete file from local storage
   * @param relativePath - Relative path of the file
   */
  async deleteFile(relativePath: string): Promise<boolean> {
    const fullPath = path.join(this.config.localPath, relativePath);

    // Security check: prevent directory traversal
    if (!this.isPathSafe(fullPath)) {
      return false;
    }

    if (!fs.existsSync(fullPath)) {
      return false;
    }

    try {
      fs.unlinkSync(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get storage statistics for a company.
   *
   * Scans the year/month/type tree and ONLY counts files inside the
   * caller's company directory. The previous implementation scanned
   * the whole base dir and summed every file in every company, which
   * was a multi-tenant leak — Company A would see Company B's storage
   * usage in the dashboard.
   *
   * The directory layout is {year}/{month}/{type}/{companyId}/, so
   * we walk the tree and count a file only when its path ends with
   * /{companyId}/{filename}. Earlier draft (2026-06-06) tried to
   * short-circuit on the first companyId match, which truncated
   * counting as soon as one year/month/type triple was processed —
   * fixed by visiting every (year, month, type) leaf and checking
   * if it contains a matching companyId.
   */
  async getStorageStats(companyId: string): Promise<StorageStats> {
    const stats: StorageStats = {
      totalFiles: 0,
      totalSize: 0,
      usageByType: {},
    };

    if (!companyId || !fs.existsSync(this.config.localPath)) return stats;

    const base = this.config.localPath

    // Year → Month → Type → companyId; we visit every (year, month, type)
    // triple and check if a matching companyId subdir exists.
    const years = this.safeReaddir(base, /^\d{4}$/)
    for (const year of years) {
      const months = this.safeReaddir(path.join(base, year), /^\d{2}$/)
      for (const month of months) {
        const types = this.safeReaddir(path.join(base, year, month))
          .filter((n) => ['pdf', 'images', 'attachments', 'image'].includes(n))
        for (const type of types) {
          const companyDir = path.join(base, year, month, type, companyId)
          if (!fs.existsSync(companyDir)) continue
          const items = fs.readdirSync(companyDir, { withFileTypes: true })
          for (const it of items) {
            if (!it.isFile()) continue
            const size = fs.statSync(path.join(companyDir, it.name)).size
            stats.totalFiles++
            stats.totalSize += size
            if (!stats.usageByType[type]) {
              stats.usageByType[type] = { count: 0, size: 0 }
            }
            stats.usageByType[type].count++
            stats.usageByType[type].size += size
          }
        }
      }
    }
    return stats;
  }

  /**
   * Save invoice PDF
   */
  async saveInvoicePdf(
    buffer: Buffer,
    invoiceNumber: string,
    companyId: string,
  ): Promise<SavedFile> {
    return this.saveFile(buffer, `${invoiceNumber}.pdf`, 'pdf', companyId);
  }

  /**
   * List all files belonging to a company, newest first.
   * Directory layout: {localPath}/{year}/{month}/{type}/{companyId}/{files}
   * The "type" is the parent directory of the company id (e.g. "pdf",
   * "images", "attachments"). When the company id is found, we know the
   * type from the dir we just walked into.
   */
  async listFiles(companyId: string): Promise<Array<{
    filename: string
    originalName: string
    path: string
    type: string
    size: number
    uploadedAt: Date
    url: string
  }>> {
    const files: Array<{
      filename: string
      originalName: string
      path: string
      type: string
      size: number
      uploadedAt: Date
      url: string
    }> = []

    if (!fs.existsSync(this.config.localPath)) return files

    const base = this.config.localPath

    // Collect files in a single company-dir under a known type.
    const collect = (companyDir: string, type: string) => {
      const items = fs.readdirSync(companyDir, { withFileTypes: true })
      for (const it of items) {
        if (!it.isFile()) continue
        const fp = path.join(companyDir, it.name)
        const st = fs.statSync(fp)
        const underscoreIdx = it.name.indexOf('_')
        const originalName =
          underscoreIdx > 0 ? it.name.substring(underscoreIdx + 1) : it.name
        const rel = path.relative(base, fp).replace(/\\/g, '/')
        files.push({
          filename: it.name,
          originalName,
          path: rel,
          type,
          size: st.size,
          uploadedAt: st.mtime,
          url: `/api/v1/storage/files/${rel.replace(/\//g, ',')}`,
        })
      }
    }

    // Walk the directory tree, tracking the most recent "type" segment.
    // The standard layout is {year}/{month}/{type}/{companyId}; the type
    // is the directory immediately above the company id.
    const walk = (dir: string, currentType?: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === companyId) {
            // Found the company dir — collect its files using the
            // type inherited from the parent dir.
            collect(full, currentType || 'other')
          } else {
            // Recurse. If this dir's name looks like a known type
            // (e.g. "pdf", "images", "attachments"), carry it forward
            // so a child company-dir knows its type.
            const isKnownType = ['pdf', 'images', 'attachments', 'image'].includes(e.name)
            walk(full, isKnownType ? e.name : currentType)
          }
        }
      }
    }
    walk(base)

    files.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
    return files
  }

  /**
   * Health check for the storage subsystem. Verifies the local
   * directory exists, is writable, and reports disk usage.
   */
  async getHealth(): Promise<{
    localPath: string
    reachable: boolean
    writable: boolean
    freeBytes?: number
  }> {
    const localPath = this.config.localPath
    const reachable = fs.existsSync(localPath)
    let writable = false
    if (reachable) {
      try {
        fs.accessSync(localPath, fs.constants.W_OK)
        writable = true
      } catch {
        writable = false
      }
    }
    let freeBytes: number | undefined
    if (reachable) {
      try {
        // Node 18+ — statfs reports free bytes on POSIX
        const stats = fs.statfsSync(localPath)
        freeBytes = stats.bavail * stats.bsize
      } catch {
        freeBytes = undefined
      }
    }
    return { localPath, reachable, writable, freeBytes }
  }

  /**
   * Get invoice PDF path
   */
  async getInvoicePdf(relativePath: string) {
    return this.getFile(relativePath);
  }

  /**
   * Check if file path is safe (prevents directory traversal)
   */
  private isPathSafe(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath);
    return normalizedPath.startsWith(this.config.localPath);
  }

  /**
   * List directory entries whose name matches a regex, returning [] on
   * any error. Used by getStorageStats when walking year/month dirs —
   * a missing or non-readable dir is a normal "no files for this period"
   * situation, not a 500.
   */
  private safeReaddir(dir: string, match?: RegExp): string[] {
    try {
      if (!fs.existsSync(dir)) return []
      const names = fs.readdirSync(dir)
      return match ? names.filter((n) => match.test(n)) : names
    } catch {
      return []
    }
  }

  /**
   * Sanitize filename to remove potentially dangerous characters
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_');
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}