import { Injectable } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_DOCUMENT_BYTES } from './document-content';

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | undefined;
  sizeBytes: number;
}

export interface BucketObject {
  key: string;
  etag: string;
  sizeBytes: number;
  lastModified: Date;
  contentType?: string;
}

@Injectable()
export class RailwayBucketService {
  private readonly config = bucketConfig(process.env);
  private readonly client = this.config
    ? new S3Client({
        region: this.config.region,
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
      })
    : null;

  isConfigured(): boolean {
    return this.client !== null && this.config !== null;
  }

  async createUploadUrl(
    key: string,
    contentType: string,
    sha256Hex: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const { client, bucket } = this.requireConfigured();
    return {
      url: await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          Metadata: { sha256: sha256Hex },
        }),
        {
          expiresIn: 15 * 60,
          unhoistableHeaders: new Set(['x-amz-meta-sha256']),
        },
      ),
      headers: {
        'content-type': contentType,
        'x-amz-meta-sha256': sha256Hex,
      },
    };
  }

  async read(key: string): Promise<StoredObject> {
    const { client, bucket } = this.requireConfigured();
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    const sizeBytes = head.ContentLength ?? -1;
    if (sizeBytes < 0 || sizeBytes > MAX_DOCUMENT_BYTES)
      return {
        bytes: new Uint8Array(),
        contentType: head.ContentType,
        sizeBytes,
      };
    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!object.Body) throw new Error('Stored document has no body');
    return {
      bytes: await object.Body.transformToByteArray(),
      contentType: head.ContentType,
      sizeBytes,
    };
  }

  async stat(key: string): Promise<BucketObject> {
    const { client, bucket } = this.requireConfigured();
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (head.ContentLength === undefined || !head.ETag || !head.LastModified)
      throw new Error('Stored object metadata is incomplete');
    return {
      key,
      etag: head.ETag.replaceAll('"', ''),
      sizeBytes: head.ContentLength,
      lastModified: head.LastModified,
      contentType: head.ContentType,
    };
  }

  async list(
    prefix: string,
    continuationToken?: string,
  ): Promise<{ objects: BucketObject[]; continuationToken?: string }> {
    const { client, bucket } = this.requireConfigured();
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 100,
      }),
    );
    return {
      objects: (result.Contents ?? []).flatMap((item) =>
        item.Key && item.ETag && item.Size !== undefined && item.LastModified
          ? [
              {
                key: item.Key,
                etag: item.ETag.replaceAll('"', ''),
                sizeBytes: item.Size,
                lastModified: item.LastModified,
              },
            ]
          : [],
      ),
      continuationToken: result.IsTruncated
        ? result.NextContinuationToken
        : undefined,
    };
  }

  async write(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    sha256Hex: string,
  ): Promise<void> {
    const { client, bucket } = this.requireConfigured();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        Metadata: { sha256: sha256Hex },
      }),
    );
  }

  async finalize(
    stagingKey: string,
    finalKey: string,
    sourceEtag?: string,
  ): Promise<void> {
    const { client, bucket } = this.requireConfigured();
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: finalKey,
        CopySource: `${bucket}/${stagingKey}`,
        CopySourceIfMatch: sourceEtag,
      }),
    );
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    await this.finalize(sourceKey, destinationKey);
    await this.delete(sourceKey);
  }

  async delete(key: string): Promise<void> {
    const { client, bucket } = this.requireConfigured();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async createDownloadUrl(key: string, filename: string): Promise<string> {
    const { client, bucket } = this.requireConfigured();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeFilename(filename)}"`,
      }),
      { expiresIn: 5 * 60 },
    );
  }

  private requireConfigured(): { client: S3Client; bucket: string } {
    if (!this.client || !this.config)
      throw new Error('Railway Bucket is not configured');
    return { client: this.client, bucket: this.config.bucket };
  }
}

function bucketConfig(env: NodeJS.ProcessEnv) {
  const endpoint = env.RAILWAY_BUCKET_ENDPOINT?.trim();
  const bucket = env.RAILWAY_BUCKET_NAME?.trim();
  const accessKeyId = env.RAILWAY_BUCKET_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.RAILWAY_BUCKET_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.RAILWAY_BUCKET_REGION?.trim() || 'auto',
    forcePathStyle: env.RAILWAY_BUCKET_URL_STYLE?.trim() === 'path',
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'document';
}
