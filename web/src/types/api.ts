/** 前后端共享 API 形状（camelCase，对应 architecture.md §3.3） */

export interface Product {
  id: string;
  name: string;
  description: string | null;
  sellingPoints: string[];
  keywords: string[];
  companyIntro: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CompanySource = string;

export interface Company {
  id: string;
  dedupeKey: string;
  name: string;
  website: string | null;
  country: string;
  description: string | null;
  mainProducts: string[];
  email: string | null;
  linkedinUrl: string | null;
  source: CompanySource;
  isFavorite: boolean;
  crmStatus: string | null;
  nextFollowUpAt: string | null;
  searchedAt: string;
  createdAt: string;
  updatedAt: string;
  /** CRM 列表/企业列表附加字段（服务端 include 后映射） */
  latestScore?: { score: number | null; grade: string | null } | null;
  latestActivity?: { content: string; createdAt: string } | null;
}

export interface Contact {
  id: string;
  companyId: string;
  name: string;
  title: string;
  email: string | null;
  linkedinUrl: string | null;
  country: string | null;
  source: string;
  emailVerified: 'VERIFIED' | 'UNVERIFIED' | 'UNKNOWN';
  isManual: boolean;
}

export interface CustomsRecord {
  id: string;
  companyId: string;
  companyName: string;
  importCountry: string;
  productDescription: string | null;
  hsCode: string | null;
  shipmentDate: string;
  quantity: string | null;
  supplierCountry: string | null;
  supplierName: string | null;
  source: string;
}

export interface SearchTask {
  id: string;
  productId: string | null;
  params: {
    productKeywords: string[];
    country: string;
    companyTypes: string[];
    industryKeywords?: string[];
    limit: number;
  };
  status: 'PENDING' | 'SEARCHING' | 'ENRICHING' | 'SCORING' | 'EMAILING' | 'DONE' | 'FAILED';
  totalCompanies: number;
  processedCompanies: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CrmActivity {
  id: string;
  companyId: string;
  userId: string;
  type: 'NOTE' | 'STATUS_CHANGE' | 'FOLLOW_UP';
  content: string;
  nextFollowUpAt: string | null;
  createdAt: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: Pagination;
}

// ---------- AI（阶段 6） ----------

export interface LeadScore {
  id: string;
  companyId: string;
  status: string;
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | null;
  matchReasons: string[];
  purchaseNeeds: string | null;
  opportunities: string | null;
  suggestions: string | null;
  uncertaintyNotes: string | null;
  subScores: Record<string, number> | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export interface EmailDraft {
  id: string;
  companyId: string;
  contactId: string | null;
  subject: string;
  body: string;
  followUp1: string | null;
  followUp2: string | null;
  model: string | null;
  createdAt: string;
}
