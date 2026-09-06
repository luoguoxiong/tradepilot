import { authHandlers } from './handlers/auth'

/** 全量 mock handlers：按接口文档逐份实现（06 §5.3），MSW handler 与单测复用 */
export const handlers = [...authHandlers]
