import { z } from 'zod';

/** 手动补充联系人（API 失败兜底路径；PRD §3.2） */
export const ManualContactSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  title: z.string().trim().min(1, 'title is required').max(120),
  email: z.string().trim().toLowerCase().email('invalid email').max(200).optional(),
  linkedinUrl: z.string().trim().url('invalid url').max(500).optional(),
  country: z.string().trim().length(2).toUpperCase().optional(),
});

export const DiscoverContactsSchema = z.object({
  titles: z
    .array(z.string().trim().min(1).max(80))
    .max(6)
    .default(['Purchasing Manager', 'Procurement Manager', 'Sourcing Manager', 'Import Manager', 'CEO', 'Founder']),
});

export type ManualContactInput = z.infer<typeof ManualContactSchema>;
export type DiscoverContactsInput = z.infer<typeof DiscoverContactsSchema>;
