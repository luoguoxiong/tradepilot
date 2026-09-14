/**
 * @tradepilot/integrations —— 邮箱驱动（Gmail/Outlook/SMTP-IMAP）、搜索/抓取、
 * 嵌入服务、对象存储适配器（后端技术方案 06）。
 * 依赖方向：integrations → core/shared。
 */
export { createMailboxDriver } from './mailbox/factory.js';
export { createSmtpImapDriver } from './mailbox/smtp-imap.js';
export { MailboxAuthError, MailboxSendError, isMailboxAuthError } from './mailbox/errors.js';
export {
  decryptChannelCredential,
  decryptRefreshToken,
  getMicrosoftAccessToken,
  assertGoogleOAuthConfig,
} from './mailbox/credentials.js';
export type {
  MailboxDriver,
  MailboxDriverOptions,
  MailboxDriverRow,
  RawMessage,
  OutboundMessage,
  SyncParams,
  DriverTestResult,
  SendMessageResult,
} from './mailbox/types.js';

// ===== M4 #6/#7：搜索抓取 / 嵌入服务 / 对象存储适配（06 §3 / 07 §2）=====
export {
  createEmbeddingProvider,
  setEmbeddingProviderFactory,
  getEmbeddingProvider,
  OpenAiEmbeddingProvider,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
} from './embedding/index.js';
export type {
  EmbeddingProvider,
  EmbeddingProviderFactory,
  EmbeddingOptions,
} from './embedding/index.js';
export {
  createS3Storage,
  configureObjectStorage,
  getObjectStorage,
  isObjectStorageConfigured,
  knowledgeDocKey,
} from './storage/index.js';
export type { ObjectStorage, S3StorageOptions } from './storage/index.js';
export {
  createSearchProvider,
  setSearchProviderFactory,
  getSearchProvider,
  HttpSearchProvider,
  SEARCH_BACKOFF_MS,
  SEARCH_MAX_ATTEMPTS,
  SEARCH_TIMEOUT_MS,
  decodeEntities,
  extractLinks,
  htmlToText,
  normalizeHost,
  PAGE_LINK_LIMIT,
  PAGE_TEXT_LIMIT,
} from './search/index.js';
export type {
  SearchProvider,
  SearchProviderFactory,
  WebSearchHit,
  SiteCrawlResult,
  FetchedPage,
  HttpSearchOptions,
} from './search/index.js';

// ===== P1-X-21：出站 Webhook 投递（16 FR-11 / 06 §5.2）=====
export {
  deliverWebhook,
  signWebhookPayload,
  WebhookDeliveryError,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_SIGNATURE_HEADER,
} from './webhook-out/index.js';
export type {
  DeliverWebhookOptions,
  WebhookDeliveryResult,
  WebhookPayloadLike,
} from './webhook-out/index.js';
