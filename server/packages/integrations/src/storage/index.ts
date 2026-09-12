/**
 * 对象存储适配（后端技术方案 07 §2 / 08 §7）：
 * S3 兼容（MinIO）最小客户端——PutObject / GetObject / PutBucket，AWS SigV4 签名（node:crypto）。
 * 不引入 aws-sdk：仅三个操作，避免依赖膨胀；路径风格寻址（path-style，MinIO 约定）。
 * 进程级注入同 email-send-config 模式。
 */
import { createHash, createHmac } from 'node:crypto';

export interface ObjectStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  /** 启动期确保桶存在（不存在则创建；已存在为幂等 no-op） */
  ensureBucket(): Promise<void>;
}

export interface S3StorageOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export class S3Storage implements ObjectStorage {
  private readonly endpointUrl: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  constructor(options: S3StorageOptions) {
    this.endpointUrl = new URL(options.endpoint);
    this.bucket = options.bucket;
    this.region = options.region;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.request('PUT', key, body, { 'content-type': contentType });
    if (!res.ok) {
      // 关键：不校验会静默吞掉 NoSuchBucket 等失败，导致 upload 的自举重试分支永不触发
      await this.throwS3Error(res, '写入', key);
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.request('GET', key, undefined);
    if (!res.ok) {
      await this.throwS3Error(res, '读取', key);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async ensureBucket(): Promise<void> {
    // HEAD bucket：200 已存在 → no-op；404 → PUT 创建（幂等）
    const head = await this.request('HEAD', '', undefined);
    if (head.status === 200) {
      return;
    }
    if (head.status !== 404) {
      await this.throwS3Error(head, '存储检查', '');
    }
    const res = await this.request('PUT', '', undefined);
    if (!res.ok) {
      await this.throwS3Error(res, '存储创建', '');
    }
  }

  /** 统一错误抛出：带 HTTP 状态与 MinIO 返回体摘要，便于定位（如 NoSuchBucket / 签名错） */
  private async throwS3Error(res: Response, action: string, key: string): Promise<never> {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(
      `对象${action}失败（${res.status}）: s3://${this.bucket}/${key}${detail ? ` — ${detail}` : ''}`,
    );
  }

  /** SigV4 签名请求（path-style：/{bucket}/{key}；返回原始 Response） */
  private async request(
    method: 'PUT' | 'GET' | 'HEAD',
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const host = this.endpointUrl.host;
    const path = `/${this.bucket}${key ? `/${key}` : ''}`;
    const url = `${this.endpointUrl.origin}${path}`;
    const now = new Date();
    const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`; // yyyyMMddTHHmmssZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? Buffer.alloc(0));

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}\n`)
      .join('');

    const canonicalRequest = [
      method,
      encodeURI(path),
      '', // query 为空
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
      '\n',
    );

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return fetch(url, {
      method,
      headers: { ...headers, authorization },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }
}

export function createS3Storage(options: S3StorageOptions): S3Storage {
  return new S3Storage(options);
}

// ===== 进程级注入（api/worker 启动时一次）=====

let configured: ObjectStorage | null = null;

export function configureObjectStorage(storage: ObjectStorage): void {
  configured = storage;
}

export function getObjectStorage(): ObjectStorage {
  if (!configured) {
    throw new Error('对象存储未初始化（configureObjectStorage 未调用）');
  }
  return configured;
}

export function isObjectStorageConfigured(): boolean {
  return configured !== null;
}

/** 知识原文对象 key（07 §2：kdoc/{orgId}/{docId}.{ext}） */
export function knowledgeDocKey(orgId: string, docId: string, ext: string): string {
  return `kdoc/${orgId}/${docId}.${ext}`;
}
