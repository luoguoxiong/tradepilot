import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createMemoryHistory, createRouter } from 'vue-router'

import ApprovalCard from '@/features/approvals/components/ApprovalCard.vue'
import { i18n } from '@/locales'
import type { ApprovalItem } from '@/api/types/approvals'

/**
 * ApprovalCard 单测（M5-B4 / 12 §2/§3）：
 * - 风险分级 tag（high danger / medium warning）+ 状态 tag；
 * - context 按 approvalType 差异化：email_send（联系人/主题/正文预览）/ customer_delete（客户名/关联数）/
 *   quote（报价单号+金额，D10）/ order_change（订单号+交期/金额变更前后，D10）；
 * - 三态处置入口：pending 显示批准/拒绝，仅 email_send 显示「编辑后批准」（决策 8）；
 * - expired 终态禁处置 + 超时提示；已处置显示处置人/拒绝理由；
 * - 倒计时口径：<48h 剩余小时 / ≥48h 剩余天数 / 负数已超时。
 */
function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    approvalId: 'appr_1',
    approvalType: 'email_send',
    riskLevel: 'medium',
    title: '发送邮件：Price list follow-up',
    status: 'pending',
    context: {
      conversationId: 'conv_1',
      customerId: 'cus_1',
      contactName: 'Anna Müller',
      subject: 'RE: Spring collection',
      contentPreview: 'Hi Anna, thanks for your interest in our new collection',
    },
    aiProposal: { emailContent: 'Hi Anna, ...' },
    confidence: 0.92,
    reasons: [{ text: '客户明确索要报价单', evidence: 'RE: Spring collection' }],
    createdAt: '2026-09-07T08:00:00Z',
    expiresAt: new Date(Date.now() + 30 * 3600_000).toISOString(),
    ...overrides,
  }
}

function mountCard(item: ApprovalItem) {
  return mount(ApprovalCard, {
    props: { approval: item },
    global: { plugins: [ElementPlus, i18n] },
  })
}

/** D10：quote/order_change 卡片含来源深链（RouterLink），需注入最小路由 */
function mountCardWithRouter(item: ApprovalItem) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/quotes/:id', name: 'quote-detail', component: { template: '<div />' } },
      { path: '/orders/:id', name: 'order-detail', component: { template: '<div />' } },
    ],
  })
  return mount(ApprovalCard, {
    props: { approval: item },
    global: { plugins: [ElementPlus, i18n, router] },
  })
}

describe('ApprovalCard', () => {
  it('email_send pending：medium 风险 tag + 联系人/主题/正文预览 + 三态按钮', () => {
    const wrapper = mountCard(makeItem())
    const tags = wrapper.findAll('.el-tag')
    expect(tags.some((t) => t.text() === '中风险')).toBe(true)
    expect(wrapper.text()).toContain('Anna Müller')
    expect(wrapper.text()).toContain('RE: Spring collection')
    expect(wrapper.text()).toContain('Hi Anna, thanks for your interest in our new collection…')
    expect(wrapper.text()).toContain('剩余 30 小时')
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons.some((b) => b.includes('批准'))).toBe(true)
    expect(buttons.some((b) => b.includes('编辑后批准'))).toBe(true)
    expect(buttons.some((b) => b.includes('拒绝'))).toBe(true)
  })

  it('customer_delete：high 风险 tag（danger）+ 客户名/关联数，无「编辑后批准」', () => {
    const wrapper = mountCard(
      makeItem({
        approvalType: 'customer_delete',
        riskLevel: 'high',
        title: '删除客户：ABC Sports',
        context: {
          customerId: 'cus_8',
          customerName: 'ABC Sports',
          relatedCounts: { quotes: 2, orders: 1 },
        },
      }),
    )
    const tags = wrapper.findAll('.el-tag')
    expect(tags.some((t) => t.text() === '高风险')).toBe(true)
    expect(wrapper.text()).toContain('ABC Sports')
    expect(wrapper.text()).toContain('报价 2')
    expect(wrapper.text()).toContain('订单 1')
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons.some((b) => b.includes('编辑后批准'))).toBe(false)
    expect(buttons.some((b) => b.includes('批准'))).toBe(true)
  })

  it('quote（D10）：报价单号 + 金额币种 + 来源深链，无「编辑后批准」', () => {
    const wrapper = mountCardWithRouter(
      makeItem({
        approvalType: 'quote',
        riskLevel: 'high',
        title: '报价提交审批：Q-20260901',
        context: {
          quoteId: 'quo_1',
          quoteNo: 'Q-20260901',
          customerId: 'cus_1',
          totalAmount: '12500.00',
          currency: 'USD',
        },
      }),
    )
    expect(wrapper.findAll('.el-tag').some((t) => t.text() === '高风险')).toBe(true)
    expect(wrapper.text()).toContain('报价单号')
    expect(wrapper.text()).toContain('Q-20260901')
    expect(wrapper.text()).toContain('USD 12500.00')
    expect(wrapper.find('a').attributes('href')).toBe('/quotes/quo_1')
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons.some((b) => b.includes('批准'))).toBe(true)
    expect(buttons.some((b) => b.includes('编辑后批准'))).toBe(false)
  })

  it('order_change（D10）：订单号 + 交期/金额变更前后 + 来源深链', () => {
    const wrapper = mountCardWithRouter(
      makeItem({
        approvalType: 'order_change',
        riskLevel: 'medium',
        title: '订单变更审批：SO-20260901',
        context: {
          orderId: 'ord_1',
          orderNo: 'SO-20260901',
          before: { deliveryDate: '2026-10-01', amount: '12500.00' },
          changes: { deliveryDate: '2026-10-15', amount: '13000.00' },
        },
      }),
    )
    expect(wrapper.text()).toContain('SO-20260901')
    expect(wrapper.text()).toContain('2026-10-01 → 2026-10-15')
    expect(wrapper.text()).toContain('12500.00 → 13000.00')
    expect(wrapper.find('a').attributes('href')).toBe('/orders/ord_1')
  })

  it('order_change（D10）：缺失侧以 — 占位（原无交期 → 新增交期）', () => {
    const wrapper = mountCardWithRouter(
      makeItem({
        approvalType: 'order_change',
        context: {
          orderId: 'ord_2',
          orderNo: 'SO-20260902',
          before: { deliveryDate: null, amount: '800.00' },
          changes: { deliveryDate: '2026-11-01' },
        },
      }),
    )
    expect(wrapper.text()).toContain('— → 2026-11-01')
    // 未变更金额不占行
    expect(wrapper.text()).not.toContain('800.00 →')
  })

  it('仅显示四态动作 emit（approve/editApprove/reject/open 携带原单）', async () => {
    const item = makeItem()
    const wrapper = mountCard(item)
    const buttons = wrapper.findAll('button')
    const byText = (text: string) => buttons.find((b) => b.text().includes(text))!

    await byText('批准').trigger('click')
    await byText('编辑后批准').trigger('click')
    await byText('拒绝').trigger('click')
    await byText('查看详情').trigger('click')

    expect(wrapper.emitted('approve')?.[0]).toEqual([item])
    expect(wrapper.emitted('editApprove')?.[0]).toEqual([item])
    expect(wrapper.emitted('reject')?.[0]).toEqual([item])
    expect(wrapper.emitted('open')?.[0]).toEqual([item])
  })

  it('expired 终态：状态 tag 已超时 + 超时提示，隐藏处置按钮', () => {
    const wrapper = mountCard(makeItem({ status: 'expired' }))
    expect(wrapper.find('[data-testid="approval-status"]').text()).toBe('已超时')
    expect(wrapper.text()).toContain('该审批已超时关闭')
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons.some((b) => b.includes('批准'))).toBe(false)
    expect(buttons.some((b) => b.includes('拒绝'))).toBe(false)
  })

  it('已处置（rejected）：显示处置人 + 拒绝理由，无处置按钮', () => {
    const wrapper = mountCard(
      makeItem({
        status: 'rejected',
        approverName: 'Alice',
        rejectReason: '价格低于成本红线',
        decidedAt: '2026-09-07T09:00:00Z',
      }),
    )
    expect(wrapper.find('[data-testid="approval-status"]').text()).toBe('已拒绝')
    expect(wrapper.text()).toContain('Alice')
    expect(wrapper.text()).toContain('价格低于成本红线')
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons.some((b) => b.includes('批准'))).toBe(false)
  })

  it('倒计时口径：≥48h 折算天数，无 expiresAt 不渲染倒计时', () => {
    const days = mountCard(
      makeItem({ expiresAt: new Date(Date.now() + 96 * 3600_000).toISOString() }),
    )
    expect(days.text()).toContain('剩余 4 天')

    const none = mountCard(makeItem({ expiresAt: undefined }))
    expect(none.text()).not.toContain('剩余')
  })

  it('置信度进度条按百分比渲染 + reasons 逐条展示', () => {
    const wrapper = mountCard(makeItem())
    expect(wrapper.text()).toContain('92')
    expect(wrapper.findAll('.approval-card__reasons li')).toHaveLength(1)
    expect(wrapper.text()).toContain('客户明确索要报价单')
  })
})
