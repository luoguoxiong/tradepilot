/**
 * 统一响应 envelope 与分页类型（接口总览 §2.2/§2.3）。
 * code=0 成功；非 0 错误码取值见 @tradepilot/core error-codes（此处保持 number，避免底层互依赖）。
 */

export interface Envelope<T = unknown> {
  code: number;
  message: string;
  data: T;
  traceId: string;
}

/** 列表接口 data 固定结构 */
export interface PageResp<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
