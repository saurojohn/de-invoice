import { IsString, IsBoolean, IsOptional, IsEnum, IsIn, ValidateNested, IsObject } from 'class-validator';
import { Type } from 'class-transformer';

export class S3ConfigDto {
  @IsString()
  bucket!: string;

  @IsString()
  region!: string;

  @IsString()
  accessKey!: string;

  @IsString()
  secretKey!: string;

  @IsOptional()
  @IsString()
  endpoint?: string;
}

export class StorageConfigDto {
  @IsOptional()
  @IsString()
  localPath?: string;

  @IsOptional()
  @IsBoolean()
  cloudEnabled?: boolean;

  @IsOptional()
  @IsEnum(['s3', 'minio', 'local'])
  cloudProvider?: 's3' | 'minio' | 'local';

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => S3ConfigDto)
  s3Config?: S3ConfigDto;
}

export class UploadFileDto {
  /** Tier 383: a directory name under the storage root — see saveFile. */
  @IsOptional()
  @IsIn(['attachments', 'pdf', 'images'])
  type?: string;

  /** Bound to the authenticated company by CallerBoundUpload. */
  @IsOptional()
  @IsString()
  companyId?: string;
}