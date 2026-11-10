import { z } from 'zod';

/** 边界校验：zod schema 即 DTO 契约（architecture.md §5） */
export const RegisterSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(80),
  email: z.string().trim().toLowerCase().email('invalid email'),
  password: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(128, 'password too long'),
});

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('invalid email'),
  password: z.string().min(1, 'password is required').max(128),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
