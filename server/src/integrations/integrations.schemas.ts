import { z } from 'zod';

import { INTEGRATION_PROVIDERS } from './integrations.service';

export const SaveIntegrationSchema = z.object({
  apiKey: z.string().trim().min(1, 'apiKey is required').max(500),
  extra: z.record(z.string().trim().min(1).max(500)).optional(),
});

export const ProviderParamSchema = z.enum(INTEGRATION_PROVIDERS);

export type SaveIntegrationInput = z.infer<typeof SaveIntegrationSchema>;
