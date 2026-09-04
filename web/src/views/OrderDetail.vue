<script setup lang="ts">
/**
 * /orders/:id 订单详情：
 * 概要卡（编辑）+ 产品行 + 进度时间线（手动更新）+ 单证（模板生成/校验/版本留痕/打印）+ 邮件（AI草稿→编辑→确认发送）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api, nodeLabel, ORDER_NODES, INCOTERMS_OPTIONS,
  type OrderDetail, type OrderItemPayload, type OrderMail, type DocType, type DocResult
} from '../api/client'

const props = defineProps<{ id: string }>()

const detail = ref<OrderDetail | null>(null)
const loading = ref(false)

/* ---- 进度更新 ---- */
const eventVisible = ref(false)
const eventForm = reactive({ node: '', event_date: '', note: '' })

/* ---- 编辑订单 ---- */
const editVisible = ref(false)
const editForm = reactive<{ order: Record<string, string>; items: OrderItemPayload[] }>({ order: {}, items: [] })

/* ---- 单证 ---- */
const docVisible = ref(false)
const docGenerating = ref(false)
const docForm = reactive({
  doc_type: 'pi' as DocType,
  note: '',
  overrides: { seller_name: '', buyer_address: '', consignee: '', marks: '', cartons: '', gross_weight: '', net_weight: '', volume: '', remarks: '' } as Record<string, string>
})
const docIssues = ref<string[]>([])
const DOC_LABEL: Record<DocType, string> = { pi: 'PI（形式发票）', invoice: 'Invoice（商业发票）', pl: 'Packing List（装箱单）' }

/* ---- 邮件 ---- */
const mailVisible = ref(false)
const mailGenerating = ref(false)
const mailForm = reactive({ kind: 'progress' as 'progress' | 'chase', to: '', tone: 'gentle' as 'gentle' | 'formal', extraNote: '' })
const editingMail = ref<OrderMail | null>(null)
const sendingMailId = ref(0)

const activeNode = computed(() => detail.value?.events.length ? detail.value.events[detail.value.events.length - 1].node : '')

async function load(): Promise<void> {
  loading.value = true
  try {
    detail.value = await api.getOrder(props.id)
  } finally {
    loading.value = false
  }
}

/* ---- 进度 ---- */
function openEvent(): void {
  eventForm.node = ''
  eventForm.event_date = new Date().toISOString().slice(0, 10)
  eventForm.note = ''
  eventVisible.value = true
}
async function submitEvent(): Promise<void> {
  if (!eventForm.node) {
    ElMessage.warning('请选择节点')
    return
  }
  await api.addOrderEvent(Number(props.id), { ...eventForm })
  ElMessage.success('进度已更新')
  eventVisible.value = false
  await load()
}

/* ---- 编辑 ---- */
function openEdit(): void {
  const d = detail.value!
  editForm.order = {
    order_no: d.order_no, customer_name: d.customer_name, customer_email: d.customer_email,
    order_date: d.order_date, delivery_date: d.delivery_date, incoterms: d.incoterms,
    payment_terms: d.payment_terms, currency: d.currency, remarks: d.remarks
  }
  editForm.items = d.items.map((it) => ({ name: it.name, model: it.model, qty: it.qty, unit: it.unit, unit_price: it.unit_price }))
  editVisible.value = true
}
async function submitEdit(): Promise<void> {
  await api.updateOrder(Number(props.id), { order: editForm.order as never, items: editForm.items })
  ElMessage.success('订单已更新（单证请重新生成新版本）')
  editVisible.value = false
  await load()
}

/* ---- 单证 ---- */
function openDoc(type: DocType): void {
  docForm.doc_type = type
  docForm.note = ''
  docForm.overrides = { seller_name: '', buyer_address: '', consignee: '', marks: '', cartons: '', gross_weight: '', net_weight: '', volume: '', remarks: '' }
  docIssues.value = []
  docVisible.value = true
}
async function generateDoc(): Promise<void> {
  docGenerating.value = true
  docIssues.value = []
  try {
    // 只提交非空 override，避免触发「微调需注明原因」
    const overrides: Record<string, string> = {}
    for (const [k, v] of Object.entries(docForm.overrides)) {
      if (String(v).trim()) overrides[k] = String(v).trim()
    }
    const r: DocResult = await api.generateDoc(Number(props.id), {
      doc_type: docForm.doc_type,
      overrides: Object.keys(overrides).length ? overrides : undefined,
      note: docForm.note || undefined
    })
    ElMessage.success(`已生成 ${r.doc_no}`)
    docVisible.value = false
    window.open(api.docHtmlUrl(r.id), '_blank')
    await load()
  } catch (e) {
    // 后端校验未通过：code=2，issues 在 data 中（拦截器 reject 前已弹 message）
    const err = e as { response?: { data?: { data?: { issues?: string[] } } } }
    const issues = err.response?.data?.data?.issues
    if (issues?.length) {
      docIssues.value = issues
    }
  } finally {
    docGenerating.value = false
  }
}
function viewDoc(docId: number): void {
  window.open(api.docHtmlUrl(docId), '_blank')
}

/* ---- 邮件 ---- */
function openMail(kind: 'progress' | 'chase'): void {
  mailForm.kind = kind
  mailForm.to = detail.value?.customer_email || ''
  mailForm.tone = kind === 'chase' ? 'formal' : 'gentle'
  mailForm.extraNote = ''
  mailVisible.value = true
}
async function generateMail(): Promise<void> {
  mailGenerating.value = true
  try {
    const mail = await api.generateMailDraft(Number(props.id), { ...mailForm })
    ElMessage.success('草稿已生成，请编辑确认后发送')
    mailVisible.value = false
    editingMail.value = mail
    await load()
  } finally {
    mailGenerating.value = false
  }
}
function editExisting(mail: OrderMail): void {
  editingMail.value = mail
}
async function saveMailDraft(): Promise<void> {
  const m = editingMail.value!
  await api.updateMail(m.id, { subject: m.subject, body: m.body })
  ElMessage.success('草稿已保存')
  await load()
}
/** 红线：发送前二次确认 */
async function sendMail(mail: OrderMail): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认发送给 ${mail.to_addr}？发送后不可撤回。`,
      '发送确认',
      { type: 'warning', confirmButtonText: '确认发送', cancelButtonText: '再看看' }
    )
  } catch {
    return
  }
  sendingMailId.value = mail.id
  try {
    await api.sendMail(mail.id)
    ElMessage.success('发送成功')
    editingMail.value = null
    await load()
  } finally {
    sendingMailId.value = 0
  }
}

function fmtMoney(): string {
  const d = detail.value
  return d ? `${d.currency} ${Number(d.total_amount).toLocaleString()}` : ''
}

onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <el-page-header content="订单详情" class="mb12" @back="$router.back()" />

    <template v-if="detail">
      <!-- 概要卡 -->
      <el-card shadow="never" class="mb12">
        <template #header>
          <div class="card-head">
            <b>{{ detail.order_no || `#${detail.id}` }} · {{ detail.customer_name }}</b>
            <div>
              <el-tag :type="detail.status === 'active' ? 'success' : 'info'" size="small">
                {{ detail.status === 'active' ? '进行中' : detail.status === 'closed' ? '已关闭' : '已取消' }}
              </el-tag>
              <el-button size="small" class="ml8" @click="openEdit">编辑</el-button>
              <el-button
                v-if="detail.status === 'active'" size="small" type="warning"
                @click="api.setOrderStatus(detail.id, 'closed').then(load)"
              >关闭订单</el-button>
            </div>
          </div>
        </template>
        <el-descriptions :column="4" size="small">
          <el-descriptions-item label="金额">{{ fmtMoney() }}</el-descriptions-item>
          <el-descriptions-item label="下单日期">{{ detail.order_date || '—' }}</el-descriptions-item>
          <el-descriptions-item label="交期">{{ detail.delivery_date || '—' }}</el-descriptions-item>
          <el-descriptions-item label="贸易术语">{{ detail.incoterms || '—' }}</el-descriptions-item>
          <el-descriptions-item label="付款方式">{{ detail.payment_terms || '—' }}</el-descriptions-item>
          <el-descriptions-item label="客户邮箱">{{ detail.customer_email || '—' }}</el-descriptions-item>
          <el-descriptions-item label="当前节点">{{ activeNode ? nodeLabel(activeNode) : '—' }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ detail.source_file_name || '手动录入' }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-row :gutter="12">
        <!-- 左：产品行 + 时间线 -->
        <el-col :span="14">
          <el-card shadow="never" class="mb12">
            <template #header><b>产品行</b></template>
            <el-table :data="detail.items" size="small">
              <el-table-column prop="name" label="品名" min-width="140" />
              <el-table-column prop="model" label="型号" width="100" />
              <el-table-column prop="qty" label="数量" width="80" />
              <el-table-column prop="unit" label="单位" width="70" />
              <el-table-column prop="unit_price" label="单价" width="90" />
              <el-table-column prop="amount" label="金额" width="100" />
            </el-table>
          </el-card>

          <el-card shadow="never">
            <template #header>
              <div class="card-head">
                <b>进度时间线</b>
                <el-button type="primary" size="small" @click="openEvent">更新进度</el-button>
              </div>
            </template>
            <el-timeline>
              <el-timeline-item
                v-for="e in detail.events" :key="e.id"
                :timestamp="`${e.event_date} ${e.note || ''}`" :type="e.id === detail.events[detail.events.length - 1].id ? 'primary' : undefined"
              >
                {{ nodeLabel(e.node) }}
              </el-timeline-item>
            </el-timeline>
          </el-card>
        </el-col>

        <!-- 右：单证 + 邮件 -->
        <el-col :span="10">
          <el-card shadow="never" class="mb12">
            <template #header><b>单证生成</b></template>
            <div class="doc-actions">
              <el-button size="small" @click="openDoc('pi')">生成 PI</el-button>
              <el-button size="small" @click="openDoc('invoice')">生成 Invoice</el-button>
              <el-button size="small" @click="openDoc('pl')">生成 Packing List</el-button>
            </div>
            <el-table v-if="detail.docs.length" :data="detail.docs" size="small" class="mt12">
              <el-table-column prop="doc_no" label="单证号" min-width="170" />
              <el-table-column prop="created_at" label="生成时间" width="100">
                <template #default="{ row }">{{ String(row.created_at || '').slice(0, 10) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="70">
                <template #default="{ row }">
                  <el-button type="primary" link size="small" @click="viewDoc(row.id)">预览</el-button>
                </template>
              </el-table-column>
            </el-table>
            <p v-else class="hint">单证由订单数据确定性渲染（非 AI 生成数字），生成前自动校验金额一致性。</p>
          </el-card>

          <el-card shadow="never">
            <template #header>
              <div class="card-head">
                <b>客户邮件</b>
                <div>
                  <el-button size="small" type="primary" @click="openMail('progress')">进度汇报</el-button>
                  <el-button size="small" type="warning" @click="openMail('chase')">催货函</el-button>
                </div>
              </div>
            </template>

            <!-- 草稿编辑区 -->
            <div v-if="editingMail" class="mail-editor">
              <el-input v-model="editingMail.subject" placeholder="邮件主题" class="mb8" />
              <el-input v-model="editingMail.to_addr" placeholder="收件人" class="mb8" />
              <el-input v-model="editingMail.body" type="textarea" :rows="12" class="mb8" />
              <div class="mail-actions">
                <el-button size="small" @click="editingMail = null">关闭</el-button>
                <el-button size="small" @click="saveMailDraft">保存草稿</el-button>
                <el-button size="small" type="primary" :loading="sendingMailId === editingMail.id" @click="sendMail(editingMail)">
                  确认发送
                </el-button>
              </div>
            </div>

            <!-- 历史邮件 -->
            <el-table v-if="detail.mails.length" :data="detail.mails" size="small">
              <el-table-column prop="subject" label="主题" min-width="150" show-overflow-tooltip />
              <el-table-column prop="to_addr" label="收件人" width="140" show-overflow-tooltip />
              <el-table-column label="状态" width="80">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.status === 'sent' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">
                    {{ row.status === 'sent' ? '已发送' : row.status === 'failed' ? '失败' : '草稿' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button v-if="row.status !== 'sent'" type="primary" link size="small" @click="editExisting(row)">
                    {{ row.status === 'failed' ? '重发' : '编辑' }}
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <p v-else-if="!editingMail" class="hint">AI 根据订单事实生成草稿，你可编辑后确认发送（SMTP 需在设置页配置）。</p>
          </el-card>
        </el-col>
      </el-row>

      <!-- 更新进度 -->
      <el-dialog v-model="eventVisible" title="更新进度" width="440px">
        <el-form label-width="80px">
          <el-form-item label="节点" required>
            <el-select v-model="eventForm.node" placeholder="选择当前完成的节点">
              <el-option v-for="n in ORDER_NODES.filter((x) => x.value !== 'created')" :key="n.value" :label="n.label" :value="n.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="日期">
            <el-date-picker v-model="eventForm.event_date" type="date" value-format="YYYY-MM-DD" style="width:100%" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="eventForm.note" type="textarea" :rows="2" placeholder="可选，如 验货机构 SGS 已安排" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="eventVisible = false">取消</el-button>
          <el-button type="primary" @click="submitEvent">记录</el-button>
        </template>
      </el-dialog>

      <!-- 编辑订单 -->
      <el-dialog v-model="editVisible" title="编辑订单" width="780px">
        <el-form label-width="100px" size="default">
          <el-row :gutter="12">
            <el-col :span="12"><el-form-item label="订单号"><el-input v-model="editForm.order.order_no" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="客户名" required><el-input v-model="editForm.order.customer_name" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="客户邮箱"><el-input v-model="editForm.order.customer_email" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="下单日期"><el-date-picker v-model="editForm.order.order_date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="交期"><el-date-picker v-model="editForm.order.delivery_date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item></el-col>
            <el-col :span="12">
              <el-form-item label="贸易术语">
                <el-select v-model="editForm.order.incoterms" clearable>
                  <el-option v-for="t in INCOTERMS_OPTIONS" :key="t" :label="t" :value="t" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12"><el-form-item label="付款方式"><el-input v-model="editForm.order.payment_terms" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="币种"><el-input v-model="editForm.order.currency" maxlength="3" /></el-form-item></el-col>
          </el-row>
          <div class="items-head">
            <b>产品行（金额=数量×单价自动计算）</b>
            <el-button size="small" @click="editForm.items.push({})">加一行</el-button>
          </div>
          <div v-for="(it, i) in editForm.items" :key="i" class="item-row">
            <el-input v-model="it.name" placeholder="品名" />
            <el-input v-model="it.model" placeholder="型号" style="width:110px" />
            <el-input-number v-model="it.qty" :min="0" controls-position="right" style="width:120px" />
            <el-input v-model="it.unit" placeholder="单位" style="width:80px" />
            <el-input-number v-model="it.unit_price" :min="0" :precision="4" controls-position="right" style="width:130px" />
            <el-button type="danger" link :disabled="editForm.items.length <= 1" @click="editForm.items.splice(i, 1)">删</el-button>
          </div>
        </el-form>
        <template #footer>
          <el-button @click="editVisible = false">取消</el-button>
          <el-button type="primary" @click="submitEdit">保存</el-button>
        </template>
      </el-dialog>

      <!-- 生成单证 -->
      <el-dialog v-model="docVisible" :title="`生成 ${DOC_LABEL[docForm.doc_type]}`" width="640px">
        <el-alert
          type="info" :closable="false" class="mb12"
          title="单证数字 100% 来自订单确认数据；如需补充装箱信息可填写下方字段（需注明原因以留痕）。"
        />
        <el-form label-width="110px" size="default">
          <el-row :gutter="12">
            <el-col :span="12"><el-form-item label="我方公司名"><el-input v-model="docForm.overrides.seller_name" placeholder="卖方抬头" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="买方地址"><el-input v-model="docForm.overrides.buyer_address" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="唛头"><el-input v-model="docForm.overrides.marks" /></el-form-item></el-col>
            <template v-if="docForm.doc_type === 'pl'">
              <el-col :span="12"><el-form-item label="箱数" required><el-input v-model="docForm.overrides.cartons" /></el-form-item></el-col>
              <el-col :span="12"><el-form-item label="毛重"><el-input v-model="docForm.overrides.gross_weight" placeholder="如 850 KGS" /></el-form-item></el-col>
              <el-col :span="12"><el-form-item label="净重"><el-input v-model="docForm.overrides.net_weight" /></el-form-item></el-col>
              <el-col :span="12"><el-form-item label="体积"><el-input v-model="docForm.overrides.volume" placeholder="如 2.85 CBM" /></el-form-item></el-col>
            </template>
          </el-row>
          <el-form-item label="补充说明">
            <el-input v-model="docForm.note" type="textarea" :rows="2" placeholder="填写了上方任一微调字段时必填（留痕）" />
          </el-form-item>
        </el-form>
        <el-alert v-if="docIssues.length" type="error" :closable="false" title="校验未通过，请修正后重试：">
          <ul class="issue-list">
            <li v-for="(iss, i) in docIssues" :key="i">{{ iss }}</li>
          </ul>
        </el-alert>
        <template #footer>
          <el-button @click="docVisible = false">取消</el-button>
          <el-button type="primary" :loading="docGenerating" @click="generateDoc">生成并预览</el-button>
        </template>
      </el-dialog>

      <!-- 生成邮件 -->
      <el-dialog v-model="mailVisible" :title="mailForm.kind === 'chase' ? '生成催货函' : '生成进度汇报邮件'" width="560px">
        <el-form label-width="100px">
          <el-form-item label="收件人" required>
            <el-input v-model="mailForm.to" placeholder="客户或工厂邮箱" />
          </el-form-item>
          <el-form-item label="语气">
            <el-radio-group v-model="mailForm.tone">
              <el-radio value="gentle">温和提醒</el-radio>
              <el-radio value="formal">正式催告</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="补充说明">
            <el-input v-model="mailForm.extraNote" type="textarea" :rows="2" placeholder="需要体现在邮件里的额外信息（可选）" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="mailVisible = false">取消</el-button>
          <el-button type="primary" :loading="mailGenerating" @click="generateMail">AI 生成草稿</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.mb12 { margin-bottom: 12px; }
.mb8 { margin-bottom: 8px; }
.ml8 { margin-left: 8px; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.doc-actions { display: flex; gap: 8px; }
.hint { color: #9ca3af; font-size: 12px; }
.mail-actions { text-align: right; }
.issue-list { margin: 6px 0 0 18px; }
</style>
