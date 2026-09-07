import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { ContactPayload, CustomerPayload } from '@/api/types/customers'
import type { CustomerStage } from '@/utils/enum-map'

import {
  customerCompanyNames,
  findCustomer,
  mockActivities,
  mockContacts,
  mockCustomers,
  nextCustomerId,
  pushActivity,
} from '../data/customers'
import { registerCustomerDeleteApproval } from '../data/approvals'
import { mockMembers, nextId } from '../data/db'
import { LATENCY, fail, ok, page, readJson } from '../utils'

/** 当前演示会话用户（与 auth mock 对齐：admin，具备改派/指定他人权限） */
const CURRENT_USER_ID = 'u-demo'
const CURRENT_USER_NAME = '演示管理员'
const CURRENT_ROLE = 'admin'

const STAGE_ORDER: CustomerStage[] = ['new_lead', 'contacted', 'negotiation', 'cold']

function validOwner(ownerId: string | undefined): boolean {
  if (!ownerId) return false
  return ownerId === CURRENT_USER_ID || mockMembers.some((m) => m.memberId === ownerId)
}

function memberName(ownerId: string): string {
  return ownerId === CURRENT_USER_ID
    ? CURRENT_USER_NAME
    : (mockMembers.find((m) => m.memberId === ownerId)?.name ?? ownerId)
}

/** 客户列表兜底排序：最近活动优先，无活动排后（05 §1.1 最近活动相对时间） */
function customerSort(items: typeof mockCustomers, sortBy: string, order: 'asc' | 'desc') {
  const dir = order === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    if (sortBy === 'lastActivityAt') {
      const atA = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0
      const atB = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0
      return (atA - atB) * dir
    }
    if (sortBy === 'createdAt') {
      return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir
    }
    return 0
  })
}

/** 联系人基础校验：姓名必填 / 邮箱格式（40001） */
function validateContactBasics(body: Partial<ContactPayload>): string | null {
  if (!body.name?.trim()) return '联系人姓名为必填项'
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return '邮箱格式不正确'
  return null
}

/** 联系人邮箱 org 内唯一（ER uq_contact_org_email → 40901，PUT/POST 同口径） */
function validateContactUnique(
  body: Partial<ContactPayload>,
  excludeContactId?: string,
): string | null {
  if (!body.email) return null
  const email = body.email.toLowerCase()
  const duplicated = mockContacts.some(
    (c) => c.contactId !== excludeContactId && (c.email ?? '').toLowerCase() === email,
  )
  return duplicated ? '该邮箱已被其他联系人使用' : null
}

/** 05 CRM 客户中心（05 接口文档 §2/§3） */
export const customerHandlers = [
  http.get('/api/v1/customers', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const tab = url.searchParams.get('tab')
    const keyword = url.searchParams.get('keyword')?.toLowerCase()
    const country = url.searchParams.get('country')
    const stage = url.searchParams.get('stage')
    const ownerId = url.searchParams.get('ownerId')
    const scope = url.searchParams.get('scope')
    const sortBy = url.searchParams.get('sortBy')
    const sortOrder = url.searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc'
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = [...mockCustomers]
    if (tab === 'potential') items = items.filter((c) => !c.isFormal)
    if (tab === 'formal') items = items.filter((c) => c.isFormal)
    if (scope === 'self') items = items.filter((c) => c.ownerId === CURRENT_USER_ID)
    if (country) items = items.filter((c) => c.country === country)
    if (stage) items = items.filter((c) => c.stage === stage)
    if (ownerId) items = items.filter((c) => c.ownerId === ownerId)
    if (keyword) items = items.filter((c) => c.companyName.toLowerCase().includes(keyword))

    const ordered = customerSort(items, sortBy ?? 'createdAt', sortOrder)
    return ok(
      page(
        ordered.slice((pageNum - 1) * pageSize, pageNum * pageSize),
        ordered.length,
        pageNum,
        pageSize,
      ),
    )
  }),

  http.post('/api/v1/customers', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<CustomerPayload>(request)
    if (!body.companyName || !body.country) {
      return fail(ErrorCode.BAD_REQUEST, '公司名称与国家为必填项')
    }
    if (!body.ownerId) return fail(ErrorCode.BAD_REQUEST, '请指定负责人')
    // 负责人默认当前操作人；指定他人仅经理/管理员（03/05 §4）
    let ownerId = CURRENT_USER_ID
    if (body.ownerId && body.ownerId !== CURRENT_USER_ID) {
      if (CURRENT_ROLE !== 'admin' && CURRENT_ROLE !== 'manager') {
        return fail(ErrorCode.FORBIDDEN, '业务员不可指定他人为负责人')
      }
      if (!validOwner(body.ownerId)) return fail(ErrorCode.BAD_REQUEST, '目标负责人不存在')
      ownerId = body.ownerId
    }
    const normalized = body.companyName.toLowerCase()
    if (customerCompanyNames.has(normalized)) {
      return fail(ErrorCode.CONFLICT, '该公司已存在于客户中心，请勿重复添加')
    }

    const created = {
      customerId: nextCustomerId(),
      companyName: body.companyName,
      country: body.country,
      website: body.website ?? '',
      industry: body.industry ?? '',
      customerType: body.customerType ?? 'other',
      isFormal: body.isFormal === true,
      stage: (body.stage as CustomerStage) ?? 'new_lead',
      ownerId,
      ownerName: memberName(ownerId),
      lastActivityAt: null,
      nextAction: null,
      reactivateSuggestion: null,
      deleteLocked: false,
      remark: body.remark ?? '',
      contactsCount: 0,
      createdAt: new Date().toISOString(),
    }
    mockCustomers.push(created)
    customerCompanyNames.add(normalized)
    // 创建时携带联系人（05 §1.2 子表单，owner 权限内直接写入）
    for (const c of body.contacts ?? []) {
      if (!c.name) continue
      mockContacts.push({
        contactId: nextId('con'),
        name: c.name,
        title: c.title ?? '',
        email: c.email ?? '',
        customerId: created.customerId,
        companyName: created.companyName,
        decisionInfluencePct: null,
        isPrimary: false,
      })
    }
    return ok(created)
  }),

  // GET /api/v1/customers/:id 详情（05 §3.1 复用 04）→ customer360Handlers 头部 + Overview（双数据源）
  // 注：不再在此定义，避免与 360 Profile 同路径重复注册（05 接口文档：详情复用 04）

  http.put('/api/v1/customers/:id', async ({ request, params }) => {
    await delay(LATENCY)
    const item = findCustomer(String(params.id))
    if (!item) return fail(ErrorCode.NOT_FOUND, '客户不存在或已被删除')
    if (item.deleteLocked) {
      return fail(ErrorCode.CONFLICT, '该客户删除审批处理中，锁定期间不可编辑')
    }
    const body = await readJson<CustomerPayload>(request)

    // 改 ownerId 即转交：仅经理/管理员（05 §4）
    if (body.ownerId && body.ownerId !== item.ownerId) {
      if (CURRENT_ROLE !== 'admin' && CURRENT_ROLE !== 'manager') {
        return fail(ErrorCode.FORBIDDEN, '业务员不可转交客户（仅经理/管理员可操作）')
      }
      if (!validOwner(body.ownerId)) return fail(ErrorCode.BAD_REQUEST, '目标负责人不存在')
      const fromOwner = item.ownerName
      item.ownerId = body.ownerId
      item.ownerName = memberName(body.ownerId)
      pushActivity({
        type: 'owner_change',
        summary: `负责人由「${fromOwner}」改派为「${item.ownerName}」`,
        customerId: item.customerId,
        customerName: item.companyName,
        operatorType: 'user',
        operatorName: CURRENT_USER_NAME,
      })
    }

    if (body.companyName !== undefined) item.companyName = body.companyName
    if (body.country !== undefined) item.country = body.country
    if (body.website !== undefined) item.website = body.website
    if (body.industry !== undefined) item.industry = body.industry
    if (body.customerType !== undefined) item.customerType = body.customerType
    if (body.isFormal !== undefined) item.isFormal = body.isFormal
    if (body.remark !== undefined) item.remark = body.remark
    item.updatedAt = new Date().toISOString()
    return ok(item)
  }),

  http.post('/api/v1/customers/:id/stage', async ({ request, params }) => {
    await delay(LATENCY)
    const item = findCustomer(String(params.id))
    if (!item) return fail(ErrorCode.NOT_FOUND, '客户不存在或已被删除')
    const body = await readJson<{ stage?: string; reason?: string }>(request)
    const target = body.stage as CustomerStage
    if (!target || !STAGE_ORDER.includes(target)) {
      return fail(ErrorCode.BAD_REQUEST, '目标阶段无效')
    }
    const currentIdx = STAGE_ORDER.indexOf(item.stage)
    const targetIdx = STAGE_ORDER.indexOf(target)
    // 仅允许正向流转或回退到 contacted（05 §3.2；非法流转 40901）
    const valid = targetIdx > currentIdx || target === 'contacted'
    if (!valid)
      return fail(ErrorCode.CONFLICT, '非法阶段流转：仅支持沿阶段机正向推进或回退至已联系')
    const previous = item.stage
    item.stage = target
    item.updatedAt = new Date().toISOString()
    const activity = pushActivity({
      type: 'stage_change',
      summary: `客户阶段由「${previous}」推进至「${target}」${body.reason ? `（${body.reason}）` : ''}`,
      customerId: item.customerId,
      customerName: item.companyName,
      operatorType: 'user',
      operatorName: CURRENT_USER_NAME,
    })
    return ok({ customerId: item.customerId, stage: item.stage, activityId: activity.activityId })
  }),

  http.delete('/api/v1/customers/:id', async ({ params }) => {
    await delay(LATENCY)
    const item = findCustomer(String(params.id))
    if (!item) return fail(ErrorCode.NOT_FOUND, '客户不存在或已被删除')
    if (item.deleteLocked) return fail(ErrorCode.CONFLICT, '该客户删除审批处理中，请勿重复发起')
    // 05 §3.3 → 12：删除 = 锁定客户 + 注册删除审批单（审批中心唯一事实源）
    const approvalId = registerCustomerDeleteApproval(item.customerId)
    if (!approvalId) return fail(ErrorCode.BIZ_VALIDATION, '删除审批注册失败')
    item.deleteLocked = true
    item.updatedAt = new Date().toISOString()
    return ok({
      approvalId,
      approvalType: 'customer_delete',
      status: 'pending',
    })
  }),

  http.post('/api/v1/customers/batch-delete', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<{ customerIds?: string[] }>(request)
    const ids = body.customerIds ?? []
    if (ids.length === 0) return fail(ErrorCode.BAD_REQUEST, '请选择要删除的客户')

    const approvals: { customerId: string; approvalId: string }[] = []
    const failed: { customerId: string; reason: string }[] = []
    for (const customerId of ids) {
      const item = findCustomer(customerId)
      if (!item) {
        failed.push({ customerId, reason: '客户不存在或已被删除' })
        continue
      }
      if (item.deleteLocked) {
        failed.push({ customerId, reason: '删除审批处理中，不可重复发起' })
        continue
      }
      item.deleteLocked = true
      const approvalId = registerCustomerDeleteApproval(customerId)
      if (approvalId) approvals.push({ customerId, approvalId })
    }
    return ok({ approvals, failed })
  }),

  http.post('/api/v1/customers/batch-owner', async ({ request }) => {
    await delay(LATENCY)
    if (CURRENT_ROLE !== 'admin' && CURRENT_ROLE !== 'manager') {
      return fail(ErrorCode.FORBIDDEN, '批量改派仅经理/管理员可操作')
    }
    const body = await readJson<{ customerIds?: string[]; ownerId?: string }>(request)
    const ids = body.customerIds ?? []
    if (ids.length === 0) return fail(ErrorCode.BAD_REQUEST, '请选择要改派的客户')
    if (!validOwner(body.ownerId)) return fail(ErrorCode.BAD_REQUEST, '目标负责人不存在')

    let updated = 0
    for (const customerId of ids) {
      const item = findCustomer(customerId)
      if (!item || item.ownerId === body.ownerId) continue
      const fromOwner = item.ownerName
      item.ownerId = body.ownerId!
      item.ownerName = memberName(body.ownerId!)
      pushActivity({
        type: 'owner_change',
        summary: `负责人由「${fromOwner}」改派为「${item.ownerName}」`,
        customerId: item.customerId,
        customerName: item.companyName,
        operatorType: 'user',
        operatorName: CURRENT_USER_NAME,
      })
      updated += 1
    }
    return ok({ updated })
  }),

  http.get('/api/v1/contacts', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const keyword = url.searchParams.get('keyword')?.toLowerCase()
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = [...mockContacts]
    if (keyword) {
      items = items.filter(
        (c) =>
          c.name.toLowerCase().includes(keyword) ||
          c.email.toLowerCase().includes(keyword) ||
          c.companyName.toLowerCase().includes(keyword),
      )
    }
    return ok(
      page(
        items.slice((pageNum - 1) * pageSize, pageNum * pageSize),
        items.length,
        pageNum,
        pageSize,
      ),
    )
  }),

  http.post('/api/v1/contacts', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<ContactPayload>(request)
    const invalid = validateContactBasics(body)
    if (invalid) return fail(ErrorCode.BAD_REQUEST, invalid)
    const duplicated = validateContactUnique(body)
    if (duplicated) return fail(ErrorCode.CONFLICT, duplicated)
    const customer = findCustomer(body.customerId!)
    if (!customer) return fail(ErrorCode.NOT_FOUND, '所属客户不存在或已被删除')
    const created = {
      contactId: nextId('con'),
      name: body.name!.trim(),
      title: body.title?.trim() ?? '',
      email: body.email ?? '',
      customerId: customer.customerId,
      companyName: customer.companyName,
      decisionInfluencePct: null,
      isPrimary: false,
    }
    mockContacts.push(created)
    // 普通写操作：不走审批、不写客户活动（05 §7 问题 3）
    return ok(created)
  }),

  http.put('/api/v1/contacts/:id', async ({ request, params }) => {
    await delay(LATENCY)
    const item = mockContacts.find((c) => c.contactId === String(params.id))
    if (!item) return fail(ErrorCode.NOT_FOUND, '联系人不存在')
    const body = await readJson<Partial<ContactPayload>>(request)
    // PUT 为部分更新：仅校验显式传入的字段（姓名/格式 → 40001；唯一冲突 → 40901）
    const invalid =
      body.name !== undefined && !body.name.trim()
        ? '联系人姓名为必填项'
        : body.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
          ? '邮箱格式不正确'
          : null
    if (invalid) return fail(ErrorCode.BAD_REQUEST, invalid)
    const duplicated = validateContactUnique(body, item.contactId)
    if (duplicated) return fail(ErrorCode.CONFLICT, duplicated)
    if (body.name !== undefined) item.name = body.name.trim()
    if (body.title !== undefined) item.title = body.title.trim()
    if (body.email !== undefined) item.email = body.email
    return ok(item)
  }),

  http.delete('/api/v1/contacts/:id', async ({ params }) => {
    await delay(LATENCY)
    const index = mockContacts.findIndex((c) => c.contactId === String(params.id))
    if (index === -1) return fail(ErrorCode.NOT_FOUND, '联系人不存在')
    mockContacts.splice(index, 1)
    return ok({ contactId: String(params.id) })
  }),

  http.get('/api/v1/activities', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const customerId = url.searchParams.get('customerId')
    const type = url.searchParams.get('type')
    const operatorType = url.searchParams.get('operatorType')
    const startDate = url.searchParams.get('startDate')
    const endDate = url.searchParams.get('endDate')
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = [...mockActivities]
    const kw = url.searchParams.get('keyword')?.toLowerCase()
    if (customerId) items = items.filter((a) => a.customerId === customerId)
    if (type) items = items.filter((a) => a.type === type)
    if (operatorType) items = items.filter((a) => a.operatorType === operatorType)
    if (kw) {
      items = items.filter(
        (a) =>
          a.summary.toLowerCase().includes(kw) ||
          (a.customerName ?? '').toLowerCase().includes(kw) ||
          a.operatorName.toLowerCase().includes(kw),
      )
    }
    if (startDate) items = items.filter((a) => a.createdAt >= startDate)
    if (endDate) items = items.filter((a) => a.createdAt <= `${endDate}T23:59:59Z`)
    // 全局时间线最新优先
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return ok(
      page(
        items.slice((pageNum - 1) * pageSize, pageNum * pageSize),
        items.length,
        pageNum,
        pageSize,
      ),
    )
  }),
]
