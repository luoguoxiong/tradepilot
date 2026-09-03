import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 8787),
  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    fallbackModel: process.env.LLM_FALLBACK_MODEL || '',
    timeoutMs: 60_000,
  },
  search: {
    provider: process.env.SEARCH_PROVIDER || 'duckduckgo',
    googleCseKey: process.env.GOOGLE_CSE_KEY || '',
    googleCseId: process.env.GOOGLE_CSE_ID || '',
    serpapiKey: process.env.SERPAPI_KEY || '',
    tavilyKey: process.env.TAVILY_API_KEY || '',
  },
  scrape: {
    pageLimit: Number(process.env.SCRAPED_PAGE_LIMIT || 5),
    timeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 15_000),
    pageDelayMs: 500,
  },
};
