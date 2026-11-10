import { z } from 'zod';

export const CreateProductSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  description: z.string().max(2000).optional(),
  sellingPoints: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  keywords: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  companyIntro: z.string().max(2000).optional(),
});

/** PATCH：全部字段可选，但至少提供一个 */
export const UpdateProductSchema = CreateProductSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'at least one field is required' },
);

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
