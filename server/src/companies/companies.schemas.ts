import { z } from 'zod';

export const ListCompaniesQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  country: z.string().trim().length(2).toUpperCase().optional(),
  isFavorite: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  inCrm: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** 企业角色筛选（进口商/供应商/未判定） */
  role: z.enum(['IMPORTER', 'SUPPLIER', 'UNCLEAR']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const FavoriteSchema = z.object({
  isFavorite: z.boolean(),
});

export const ImportCrmSchema = z.object({
  companyIds: z.array(z.string().min(1)).min(1, '至少选择一家企业').max(100),
});

export type ListCompaniesQuery = z.infer<typeof ListCompaniesQuerySchema>;
