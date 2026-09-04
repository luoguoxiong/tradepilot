<script setup lang="ts">
/**
 * /orders 订单台账：
 * KPI + 订单表格；「导入订单」（上传/粘贴→AI解析→低置信度标黄→人工确认入库）与「手动录入」
 * 解析结果必须经确认才能建单（PRD 红线）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  api, nodeLabel, INCOTERMS_OPTIONS,
  type OrderRow, type OrderImportResult, type OrderItemPayload
} from '../api/client'

const router = useRouter()
const orders = ref<OrderRow[]>([])
const loading = ref(false)

/* ---- 导入对话框状态 ---- */
const importVisible = ref(false)
const importing = ref(false)     // AI 解析中
const confirming = ref(false)   // 确认入库中
const parsed = ref<OrderImportResult | null>(null)
const importForm = reactive({
  fileName: '',
  text: '',
  order_no: '',
  customer_name: '',
  customer_email: '',
  order_date: '',
  delivery_date: '',
  incoterms: '',
  payment_terms: '',
  currency: 'USD',
  remarks: '',
  items: [] as OrderItemPayload[]
})

/** 手动录入对话框（与导入确认复用同一表单结构） */
const manualVisible = ref(false)
const manualForm = reactive({
  order_no: '',
  customer_name: '',
  customer_email: '',
  order_date: '',
  delivery_date: '',
  incoterms: '',
  payment_terms: '',
  currency: 'USD',
  remarks: '',
  items: [{}] as OrderItemPayload[]
})

/* ---- KPI ---- */
const kpi = computed(() => {
  const active = orders.value.filter((o) => o.status === 'active')
  const week = 7 * 86_400_000
  return {
    total: orders.value.length,
    active: active.length,
    dueWeek: active.filter((o) => o.days_left != null && o.days_left >= 0 && (o.days_left * 86_400_000) <= week).length,
    anomaly: orders.value.filter((o) => o.anomaly_types.length > 0).length
  }
})

async function load(): Promise<void> {
  loading.value = true
  try {
    orders.value = await api.listOrders()
  } finally {
    loading.value = false
  }
}

/* ---- 导入：文件读取 → AI 解析 ---- */
function openImport(): void {
  resetImport()
  importVisible.value = true
}
function resetImport(): void {
  parsed.value = null
  importForm.fileName = ''
  importForm.text = ''
  Object.assign(importForm, {
    order_no: '', customer_name: '', customer_email: '', order_date: '', delivery_date: '',
    incoterms: '', payment_terms: '', currency: 'USD', remarks: '', items: []
  })
}
async function onFilePick(file: File): Promise<void> {
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.error('文件过大（>8MB）')
    return
  }
  importForm.fileName = file.name
  await doParse({ fileName: file.name, contentBase64: await fileToBase64(file) })
}
/** el-upload on-change 回调（raw 为原生 File） */
function onUploadChange(uploadFile: { raw?: File }): void {
  if (uploadFile.raw && !importing.value) void onFilePick(uploadFile.raw)
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}
async function parsePasted(): Promise<void> {
  if (!importForm.text.trim()) {
    ElMessage.warning('请先粘贴订单文本')
    return
  }
  importForm.fileName = ''
  await doParse({ text: importForm.text })
}
async function doParse(payload: { fileName?: string; contentBase64?: string; text?: string }): Promise<void> {
  importing.value = true
  try {
    const r = await api.importOrder(payload)
    parsed.value = r
    fillFormFromParsed(r)
    ElMessage.success('解析完成，请核对标注字段后确认入库')
  } finally {
    importing.value = false
  }
}
/** 解析结果回填表单（低置信度字段由模板标黄提示核对） */
function fillFormFromParsed(r: OrderImportResult): void {
  const p = r.parsed
  Object.assign(importForm, {
    order_no: p.order_no || '',
    customer_name: p.customer_name || '',
    customer_email: p.customer_email || '',
    order_date: p.order_date || '',
    delivery_date: p.delivery_date || '',
    incoterms: p.incoterms || '',
    payment_terms: p.payment_terms || '',
    currency: p.currency || 'USD',
    remarks: p.remarks || '',
    items: (p.items || []).map((it) => ({
      name: it.name || '', model: it.model || '', qty: it.qty, unit: it.unit || '', unit_price: it.unit_price
    }))
  })
  if (!importForm.items.length) importForm.items = [{}]
}
const isLow = (field: string): boolean => parsed.value?.lowFields.includes(field) ?? false

/** 确认入库 */
async function confirmImport(): Promise<void> {
  if (!importForm.customer_name.trim()) {
    ElMessage.warning('客户名必填')
    return
  }
  confirming.value = true
  try {
    await api.createOrder({ importId: parsed.value?.importId, order: { ...importForm }, items: cleanItems(importForm.items) })
    ElMessage.success('订单已入库')
    importVisible.value = false
    await load()
  } finally {
    confirming.value = false
  }
}

/* ---- 手动录入 ---- */
function openManual(): void {
  manualForm.order_no = ''
  manualForm.customer_name = ''
  manualForm.customer_email = ''
  manualForm.order_date = ''
  manualForm.delivery_date = ''
  manualForm.incoterms = ''
  manualForm.payment_terms = ''
  manualForm.currency = 'USD'
  manualForm.remarks = ''
  manualForm.items = [{}]
  manualVisible.value = true
}
async function submitManual(): Promise<void> {
  if (!manualForm.customer_name.trim()) {
    ElMessage.warning('客户名必填')
    return
  }
  confirming.value = true
  try {
    await api.createOrder({ order: { ...manualForm }, items: cleanItems(manualForm.items) })
    ElMessage.success('订单已创建')
    manualVisible.value = false
    await load()
  } finally {
    confirming.value = false
  }
}

/** 过滤空行并补默认值 */
function cleanItems(items: OrderItemPayload[]): OrderItemPayload[] {
  return items
    .filter((it) => String(it.name || '').trim())
    .map((it) => ({ ...it, unit: it.unit || 'pcs' }))
}

function addItem(items: OrderItemPayload[]): void {
  items.push({})
}
function removeItem(items: OrderItemPayload[], i: number): void {
  items.splice(i, 1)
}

/** 剩余天数徽章 */
function daysBadge(days: number | null): { text: string; type: 'danger' | 'warning' | 'success' | 'info' } | null {
  if (days == null) return null
  if (days < 0) return { text: `逾期 ${-days} 天`, type: 'danger' }
  if (days <= 3) return { text: `剩 ${days} 天`, type: 'danger' }
  if (days <= 7) return { text: `剩 ${days} 天`, type: 'warning' }
  return { text: `剩 ${days} 天`, type: 'info' }
}
function daysBadgeText(days: number | null): string {
  return daysBadge(days)?.text ?? ''
}
function daysBadgeType(days: number | null): 'danger' | 'warning' | 'success' | 'info' {
  return daysBadge(days)?.type ?? 'info'
}

/** 行点击进详情 */
function openDetail(row: OrderRow): void {
  router.push(`/orders/${row.id}`)
}

const ANOMALY_LABEL: Record<string, string> = {
  overdue: '逾期', due_soon: '临期', deposit_pending: '定金', stalled: '停滞'
}

onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <div class="page-head">
      <h2 class="page-title">订单台账</h2>
      <div>
        <el-button @click="openManual">＋ 手动录入</el-button>
        <el-button type="primary" @click="openImport">上传订单解析</el-button>
      </div>
    </div>

    <!-- KPI -->
    <div class="kpi-row">
      <el-card shadow="never"><div class="kpi-num">{{ kpi.total }}</div><div class="kpi-label">全部订单</div></el-card>
      <el-card shadow="never"><div class="kpi-num">{{ kpi.active }}</div><div class="kpi-label">进行中</div></el-card>
      <el-card shadow="never"><div class="kpi-num">{{ kpi.dueWeek }}</div><div class="kpi-label">7天内交期</div></el-card>
      <el-card shadow="never"><div class="kpi-num kpi-warn">{{ kpi.anomaly }}</div><div class="kpi-label">有异常待处理</div></el-card>
    </div>

    <el-table :data="orders" @row-click="openDetail" class="clickable">
      <el-table-column prop="order_no" label="订单号" width="150" />
      <el-table-column prop="customer_name" label="客户" min-width="140" show-overflow-tooltip />
      <el-table-column label="金额" width="130">
        <template #default="{ row }">{{ row.currency }} {{ Number(row.total_amount).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column prop="delivery_date" label="交期" width="120" />
      <el-table-column label="剩余" width="110">
        <template #default="{ row }">
          <el-tag v-if="daysBadge(row.days_left)" :type="daysBadgeType(row.days_left)" size="small">
            {{ daysBadgeText(row.days_left) }}
          </el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="当前节点" width="110">
        <template #default="{ row }">{{ row.current_node ? nodeLabel(row.current_node) : '—' }}</template>
      </el-table-column>
      <el-table-column label="异常" min-width="150">
        <template #default="{ row }">
          <template v-if="row.anomaly_types.length">
            <el-tag v-for="t in row.anomaly_types" :key="t" type="danger" size="small" class="mr4">{{ ANOMALY_LABEL[t] || t }}</el-tag>
          </template>
          <span v-else class="ok-text">正常</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '进行中' : row.status === 'closed' ? '已关闭' : '已取消' }}
          </el-tag>
        </template>
      </el-table-column>
    </el-table>

    <!-- 导入/解析确认对话框 -->
    <el-dialog v-model="importVisible" title="导入订单（AI 解析 → 人工确认入库）" width="780px" :close-on-click-modal="false">
      <template v-if="!parsed">
        <el-alert type="info" :closable="false" class="mb12"
          title="支持 Excel(.xlsx/.csv)、文本型 PDF、纯文本；解析结果必须经你确认后才会入库。图片扫描件请转手动录入。" />
        <el-upload
          drag
          :auto-upload="false"
          :show-file-list="false"
          accept=".xlsx,.xls,.csv,.pdf,.txt"
          :on-change="onUploadChange"
        >
          <div v-loading="importing" class="upload-hint">
            <div class="upload-icon">📄</div>
            <div>{{ importing ? 'AI 解析中…' : '点击选择文件，或把订单邮件文本粘贴到下方' }}</div>
            <div v-if="importForm.fileName" class="picked">{{ importForm.fileName }}</div>
          </div>
        </el-upload>
        <el-input
          v-model="importForm.text"
          type="textarea"
          :rows="5"
          placeholder="或粘贴订单文本（邮件原文、PI 内容、聊天记录…）"
          class="mt12"
        />
        <div class="mt12">
          <el-button type="primary" :loading="importing" :disabled="!importForm.text.trim()" @click="parsePasted">
            解析粘贴文本
          </el-button>
        </div>
      </template>

      <template v-else>
        <el-alert type="warning" :closable="false" class="mb12"
          title="以下为 AI 解析结果，黄色字段为低置信度，请务必核对修正；确认后才会写入订单库。" />
        <el-form label-width="110px" size="default">
          <el-row :gutter="12">
            <el-col :span="12"><el-form-item label="订单号"><el-input v-model="importForm.order_no" :class="{ 'field-low': isLow('order_no') }" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="客户名" required><el-input v-model="importForm.customer_name" :class="{ 'field-low': isLow('customer_name') }" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="客户邮箱"><el-input v-model="importForm.customer_email" :class="{ 'field-low': isLow('customer_email') }" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="下单日期"><el-date-picker v-model="importForm.order_date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="交期"><el-date-picker v-model="importForm.delivery_date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item></el-col>
            <el-col :span="12">
              <el-form-item label="贸易术语">
                <el-select v-model="importForm.incoterms" placeholder="选择 Incoterms" clearable>
                  <el-option v-for="t in INCOTERMS_OPTIONS" :key="t" :label="t" :value="t" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12"><el-form-item label="付款方式"><el-input v-model="importForm.payment_terms" placeholder="如 T/T 30% deposit" /></el-form-item></el-col>
            <el-col :span="12"><el-form-item label="币种"><el-input v-model="importForm.currency" maxlength="3" /></el-form-item></el-col>
          </el-row>

          <div class="items-head">
            <b>产品行</b>
            <el-button size="small" @click="addItem(importForm.items)">加一行</el-button>
          </div>
          <div v-for="(it, i) in importForm.items" :key="i" class="item-row">
            <el-input v-model="it.name" placeholder="品名" :class="{ 'field-low': isLow(`items.${i}.name`) }" />
            <el-input v-model="it.model" placeholder="型号" style="width:110px" />
            <el-input-number v-model="it.qty" :min="0" placeholder="数量" controls-position="right" style="width:120px" :class="{ 'field-low': isLow(`items.${i}.qty`) }" />
            <el-input v-model="it.unit" placeholder="单位" style="width:80px" />
            <el-input-number v-model="it.unit_price" :min="0" :precision="4" placeholder="单价" controls-position="right" style="width:130px" :class="{ 'field-low': isLow(`items.${i}.unit_price`) }" />
            <el-button type="danger" link :disabled="importForm.items.length <= 1" @click="removeItem(importForm.items, i)">删</el-button>
          </div>
        </el-form>
        <div class="dialog-foot">
          <el-button @click="parsed = null">重新解析</el-button>
          <el-button type="primary" :loading="confirming" @click="confirmImport">确认入库</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 手动录入对话框 -->
    <el-dialog v-model="manualVisible" title="手动录入订单" width="780px" :close-on-click-modal="false">
      <el-form label-width="110px" size="default">
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="订单号"><el-input v-model="manualForm.order_no" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="客户名" required><el-input v-model="manualForm.customer_name" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="客户邮箱"><el-input v-model="manualForm.customer_email" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="下单日期"><el-date-picker v-model="manualForm.order_date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="交期"><el-date-picker v-model="manualForm.delivery_date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="贸易术语">
              <el-select v-model="manualForm.incoterms" placeholder="选择 Incoterms" clearable>
                <el-option v-for="t in INCOTERMS_OPTIONS" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="付款方式"><el-input v-model="manualForm.payment_terms" placeholder="如 T/T 30% deposit" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="币种"><el-input v-model="manualForm.currency" maxlength="3" /></el-form-item></el-col>
        </el-row>
        <div class="items-head">
          <b>产品行</b>
          <el-button size="small" @click="addItem(manualForm.items)">加一行</el-button>
        </div>
        <div v-for="(it, i) in manualForm.items" :key="i" class="item-row">
          <el-input v-model="it.name" placeholder="品名" />
          <el-input v-model="it.model" placeholder="型号" style="width:110px" />
          <el-input-number v-model="it.qty" :min="0" placeholder="数量" controls-position="right" style="width:120px" />
          <el-input v-model="it.unit" placeholder="单位" style="width:80px" />
          <el-input-number v-model="it.unit_price" :min="0" :precision="4" placeholder="单价" controls-position="right" style="width:130px" />
          <el-button type="danger" link :disabled="manualForm.items.length <= 1" @click="removeItem(manualForm.items, i)">删</el-button>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="manualVisible = false">取消</el-button>
        <el-button type="primary" :loading="confirming" @click="submitManual">创建订单</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: center; margin: 8px 0 12px; }
.page-title { font-size: 20px; margin: 0; }
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.kpi-num { font-size: 24px; font-weight: 700; }
.kpi-warn { color: #dc2626; }
.kpi-label { color: #6b7280; font-size: 12px; }
.clickable :deep(tbody tr) { cursor: pointer; }
.mr4 { margin-right: 4px; }
.ok-text { color: #16a34a; font-size: 12px; }
.mb12 { margin-bottom: 12px; }
.mt12 { margin-top: 12px; }
.upload-hint { padding: 18px 0; color: #6b7280; }
.picked { color: #2563eb; margin-top: 4px; }
.items-head { display: flex; justify-content: space-between; align-items: center; margin: 10px 0 8px; }
.item-row { display: flex; gap: 8px; margin-bottom: 8px; }
.item-row .el-input:first-child { flex: 1; }
.dialog-foot { text-align: right; margin-top: 10px; }
</style>
