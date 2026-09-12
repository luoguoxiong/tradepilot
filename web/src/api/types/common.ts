/** 全局角色（接口规范 §2.1 / 05 §1） */
export type Role = 'admin' | 'manager' | 'sales'

/** 数据范围（接口规范 §4.4 / 05 §2） */
export type DataScope = 'self' | 'team' | 'all'

/** 统一响应 envelope（接口规范 §2.2） */
export interface ApiResponse<T> {
  code: number
  message: string
  data: T
  traceId?: string
}

/** 分页响应（接口规范 §2.2：{ items, total, page, pageSize }） */
export interface PageResp<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** 列表通用查询参数（接口规范 §2.3） */
export interface PageReq {
  page?: number
  pageSize?: number
  keyword?: string
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}
