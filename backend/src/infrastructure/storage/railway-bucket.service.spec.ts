import { RailwayBucketService } from './railway-bucket.service';

describe('RailwayBucketService', () => {
  it('presigns uploads without binding them to an empty checksum', async () => {
    process.env.RAILWAY_BUCKET_ENDPOINT = 'http://localhost:9000';
    process.env.RAILWAY_BUCKET_NAME = 'opes-local';
    process.env.RAILWAY_BUCKET_ACCESS_KEY_ID = 'test';
    process.env.RAILWAY_BUCKET_SECRET_ACCESS_KEY = 'test-secret';
    process.env.RAILWAY_BUCKET_URL_STYLE = 'path';
    const upload = await new RailwayBucketService().createUploadUrl(
      'staging/test',
      'text/plain',
      'a'.repeat(64),
    );
    expect(upload.url).not.toContain('x-amz-checksum-crc32');
    expect(upload.url).toContain(
      'X-Amz-SignedHeaders=host%3Bx-amz-meta-sha256',
    );
    expect(upload.headers).toEqual({
      'content-type': 'text/plain',
      'x-amz-meta-sha256': 'a'.repeat(64),
    });
  });
});
