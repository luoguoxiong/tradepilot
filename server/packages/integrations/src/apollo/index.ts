/**
 * Apollo.io 获客数据源适配（Apollo 相似客户获客工作流）：
 * - searchOrganizations：POST /api/v1/mixed_companies/search（公司检索，关键词标签 + 地域 + 规模）
 * - searchPeople：POST /api/v1/mixed_people/search（指定公司下的联系人检索，头衔过滤）
 * 鉴权：X-Api-Key 请求头（凭据由「系统设置 → AI 模型配置」type=apollo 台账解密下发）。
 * 说明：Apollo 对 email 揭示受套餐与合规限制，锁定邮箱不落库明文（email 置空，仅保留
 * email_status），与 08 §7 数据合规「只取业务必需字段」一致。
 */

/** Apollo API 缺省端点 */
export const APOLLO_DEFAULT_BASE_URL = 'https://api.apollo.io';

export interface ApolloOptions {
  baseUrl?: string;
  apiKey: string;
  /** 单请求超时 ms（默认 30s；批量检索带分页，留足余量） */
  timeoutMs?: number;
}

/** 公司检索参数（与 Apollo mixed_companies/search 契约对齐） */
export interface ApolloOrgSearchParams {
  /** 行业/产品关键词标签（q_organization_keyword_tags，OR 语义） */
  keywordTags?: string[];
  /** 地域（organization_locations，国家/城市英文，OR 语义） */
  locations?: string[];
  /** 规模区间 [min, max][]（organization_num_employees_ranges） */
  employeeRanges?: [number, number][];
  page?: number;
  /** 每页数量（Apollo 上限 100） */
  perPage?: number;
}

export interface ApolloOrg {
  apolloOrgId: string;
  name: string;
  website: string | null;
  /** 归一化主域名（primary_domain，去 www. 小写） */
  domain: string | null;
  country: string | null;
  industry: string | null;
  employeeCount: number | null;
  linkedinUrl: string | null;
  shortDescription: string | null;
}

export interface ApolloPerson {
  apolloPersonId: string;
  name: string;
  title: string | null;
  email: string | null;
  /** verified / presumed_valid / locked / unavailable 等（原样透传） */
  emailStatus: string | null;
  linkedinUrl: string | null;
  seniority: string | null;
  organizationName: string | null;
}

export interface ApolloPeopleSearchParams {
  /** 目标公司 Apollo id（organization_ids，本次检索命中的公司） */
  organizationIds: string[];
  /** 联系人头衔过滤（person_titles，OR 语义） */
  titles?: string[];
  page?: number;
  perPage?: number;
}

export interface ApolloProvider {
  /** 检索相似公司 */
  searchOrganizations(params: ApolloOrgSearchParams): Promise<ApolloOrg[]>;
  /** 检索指定公司下的联系人 */
  searchPeople(params: ApolloPeopleSearchParams): Promise<ApolloPerson[]>;
}

/** 域名归一（与 search/index.ts normalizeHost 同口径：去协议/路径/端口，去 www.，小写） */
export function normalizeApolloDomain(domain: string | null | undefined): string | null {
  const host = (domain ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    ?.split('?')[0]
    ?.replace(/:\d+$/, '')
    .toLowerCase()
    .replace(/^www\./, '');
  return host || null;
}

export class HttpApolloProvider implements ApolloProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApolloOptions) {
    this.baseUrl = (options.baseUrl ?? APOLLO_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async searchOrganizations(params: ApolloOrgSearchParams): Promise<ApolloOrg[]> {
    const body: Record<string, unknown> = {
      page: Math.max(1, params.page ?? 1),
      per_page: Math.min(100, Math.max(1, params.perPage ?? 25)),
    };
    if (params.keywordTags?.length) {
      body.q_organization_keyword_tags = params.keywordTags;
    }
    if (params.locations?.length) {
      body.organization_locations = params.locations;
    }
    const ranges = (params.employeeRanges ?? []).filter(([min, max]) => min > 0 || max > 0);
    if (ranges.length) {
      body.organization_num_employees_ranges = ranges;
    }
    const json = await this.request<{
      organizations?: Record<string, unknown>[];
    }>('/api/v1/mixed_companies/search', body);
    return (json.organizations ?? []).map((o) => toApolloOrg(o));
  }

  async searchPeople(params: ApolloPeopleSearchParams): Promise<ApolloPerson[]> {
    if (params.organizationIds.length === 0) {
      return [];
    }
    const body: Record<string, unknown> = {
      organization_ids: params.organizationIds,
      page: Math.max(1, params.page ?? 1),
      per_page: Math.min(100, Math.max(1, params.perPage ?? 25)),
    };
    if (params.titles?.length) {
      body.person_titles = params.titles;
    }
    const json = await this.request<{ people?: Record<string, unknown>[] }>(
      '/api/v1/mixed_people/search',
      body,
    );
    return (json.people ?? []).map((p) => toApolloPerson(p));
  }

  /** 统一 POST（X-Api-Key 头鉴权；429/5xx 透传为可读错误） */
  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Api-Key': this.options.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Apollo 请求失败（${res.status}）: ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

interface ApolloRawOrg {
  id?: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
  country?: string | null;
  industry?: string | null;
  estimated_num_employees?: number | null;
  linkedin_url?: string | null;
  short_description?: string | null;
}

interface ApolloRawPerson {
  id?: string;
  name?: string;
  title?: string | null;
  email?: string | null;
  email_status?: string | null;
  linkedin_url?: string | null;
  seniority?: string | null;
  organization?: { name?: string | null } | null;
}

function toApolloOrg(o: ApolloRawOrg): ApolloOrg {
  return {
    apolloOrgId: String(o.id ?? ''),
    name: String(o.name ?? '').trim(),
    website: o.website_url ?? null,
    domain: normalizeApolloDomain(o.primary_domain ?? o.website_url),
    country: o.country ?? null,
    industry: o.industry ?? null,
    employeeCount: typeof o.estimated_num_employees === 'number' ? o.estimated_num_employees : null,
    linkedinUrl: o.linkedin_url ?? null,
    shortDescription: o.short_description ?? null,
  };
}

function toApolloPerson(p: ApolloRawPerson): ApolloPerson {
  return {
    apolloPersonId: String(p.id ?? ''),
    name: String(p.name ?? '').trim(),
    title: p.title ?? null,
    // 锁定/未揭示邮箱不落明文（合规），仅保留 email_status 供前端提示解锁
    email: p.email && p.email.includes('@') ? p.email : null,
    emailStatus: p.email_status ?? null,
    linkedinUrl: p.linkedin_url ?? null,
    seniority: p.seniority ?? null,
    organizationName: p.organization?.name ?? null,
  };
}

export function createApolloProvider(options: ApolloOptions): ApolloProvider {
  return new HttpApolloProvider(options);
}

/** Apollo 探活（系统设置保存前连通性验证）：最小化真实调用一次公司检索 */
export async function probeApolloConnection(options: ApolloOptions): Promise<void> {
  await new HttpApolloProvider(options).searchOrganizations({ page: 1, perPage: 1 });
}
