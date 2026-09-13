<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'

import { createOrder, updateOrder } from '@/api/resources/orders'
import { getQuotes } from '@/api/resources/quotes'
import { getCustomers } from '@/api/resources/customers'
import { getProducts } from '@/api/resources/products'
import { handleApiError } from '@/api/error-handler'
import type { CustomerItem, CustomerListReq } from '@/api/types/customers'
import type { ProductListItem, ProductListQuery } from '@/api/types/products'
import type { QuoteListItem, QuoteListReq } from '@/api/types/quotes'
import type {
  OrderCreateReq,
  OrderDetail,
  OrderItemPayload,
  OrderUpdateReq,
} from '@/api/types/orders'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * OrderFormDialog 建单 / 变更（10 §3.1/§3.2）：
 * - create：报价单转单（须报价 won，明细/客户由服务端快照复制）或手工建单（定价引擎核算成本）；
 * - change：交期 / 明细变更不直接落库，提交后生成 order_change 高危审批（10 §4 AI 边界），
 *   明细变更后总额由服务端按明细重算，前端不参与金额算术。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    mode?: 'create' | 'change'
    order?: OrderDetail | null
  }>(),
  { mode: 'create', order: null },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [orderId: string]
}>()

const { t } = useI18n()

/** 与 10 §3.1 createOrderSchema 的 currency 枚举保持一致 */
const CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'AUD', 'CAD'] as const

const formRef = ref<FormInstance>()
const submitting = ref(false)

interface ItemRow {
  productId: string
  quantity: number | undefined
  unitPrice: string
}

const form = reactive({
  sourceMode: 'quote' as 'quote' | 'manual',
  quoteId: '',
  customerId: '',
  currency: 'USD',
  deliveryDate: '',
  paymentTerms: '',
})

const items = ref<ItemRow[]>([])

const isChange = computed(() => props.mode === 'change')

// ===== 选项数据（已成交报价 / 客户 / 产品；pageSize 上限 100，接口规范 §2.3）=====
const { data: wonQuotes } = useQuery({
  queryKey: [...qk.orders.all, 'form-won-quotes'],
  queryFn: () => getQuotes({ status: 'won', page: 1, pageSize: 100 } as QuoteListReq),
  enabled: computed(() => props.mode === 'create'),
  staleTime: staleTime.DICT,
})

const { data: customers } = useQuery({
  queryKey: [...qk.orders.all, 'form-customers'],
  queryFn: () => getCustomers({ page: 1, pageSize: 100 } as CustomerListReq),
  staleTime: staleTime.DICT,
})

const { data: products } = useQuery({
  queryKey: [...qk.orders.all, 'form-products'],
  queryFn: () => getProducts({ page: 1, pageSize: 100 } as ProductListQuery),
  staleTime: staleTime.DICT,
})

const rules = computed<FormRules>(() => ({
  deliveryDate: [{ required: true, message: t('orders.requiredDeliveryDate'), trigger: 'change' }],
  ...(isChange.value
    ? {}
    : {
        ...(form.sourceMode === 'quote'
          ? { quoteId: [{ required: true, message: t('orders.requiredQuote'), trigger: 'change' }] }
          : {
              customerId: [
                { required: true, message: t('orders.requiredCustomer'), trigger: 'change' },
              ],
            }),
      }),
}))

function resetForm() {
  const order = props.order
  if (isChange.value && order) {
    form.sourceMode = 'manual'
    form.quoteId = ''
    form.customerId = order.customerId
    form.currency = order.currency
    form.deliveryDate = order.deliveryDate
    form.paymentTerms = order.paymentTerms ?? ''
    items.value = order.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    }))
  } else {
    form.sourceMode = 'quote'
    form.quoteId = ''
    form.customerId = ''
    form.currency = 'USD'
    form.deliveryDate = ''
    form.paymentTerms = ''
    items.value = [{ productId: '', quantity: undefined, unitPrice: '' }]
  }
  formRef.value?.clearValidate()
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) resetForm()
  },
)

/** 手工建单/变更：明细行本地校验（产品 + 正整数数量 + 正单价） */
function validateItems(): boolean {
  if (items.value.length === 0) {
    ElMessage.error(t('orders.requiredProduct'))
    return false
  }
  for (const row of items.value) {
    if (!row.productId) {
      ElMessage.error(t('orders.requiredProduct'))
      return false
    }
    if (!row.quantity || row.quantity <= 0) {
      ElMessage.error(t('orders.requiredQuantity'))
      return false
    }
    if (!row.unitPrice.trim() || Number(row.unitPrice) <= 0) {
      ElMessage.error(t('orders.requiredUnitPrice'))
      return false
    }
  }
  return true
}

function buildItems(): OrderItemPayload[] {
  return items.value.map<OrderItemPayload>((row) => ({
    productId: row.productId,
    quantity: Number(row.quantity),
    unitPrice: row.unitPrice.trim(),
  }))
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  // 转单时明细由服务端按报价快照复制，无需本地校验
  if (!(form.sourceMode === 'quote' && !isChange.value) && !validateItems()) return

  submitting.value = true
  try {
    if (isChange.value && props.order) {
      const payload: OrderUpdateReq = {
        deliveryDate: form.deliveryDate,
        items: buildItems(),
      }
      await updateOrder(props.order.orderId, payload)
      ElMessage.success(t('orders.editSuccess'))
      emit('saved', props.order.orderId)
    } else {
      const payload: OrderCreateReq = {
        deliveryDate: form.deliveryDate,
        currency: form.currency,
      }
      if (form.paymentTerms.trim()) payload.paymentTerms = form.paymentTerms.trim()
      if (form.sourceMode === 'quote') {
        payload.fromQuoteId = form.quoteId
        const quote = (wonQuotes.value?.items ?? []).find((q) => q.quoteId === form.quoteId)
        if (quote) payload.currency = quote.currency
      } else {
        payload.customerId = form.customerId
        payload.items = buildItems()
      }
      const resp = await createOrder(payload)
      ElMessage.success(t('orders.createSuccess'))
      emit('saved', resp.orderId)
    }
    emit('update:modelValue', false)
  } catch (error) {
    // 40901（已有变更审批）/ 40401 / 42201 等：error-handler 已提示，表单保留供修正
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="isChange ? t('orders.editTitle') : t('orders.formTitleCreate')"
    width="900px"
    :close-on-click-modal="false"
    append-to-body
    @close="close"
  >
    <el-alert
      v-if="isChange"
      type="warning"
      :closable="false"
      :title="t('orders.editTip')"
      class="order-form__tip"
    />

    <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
      <el-row :gutter="16">
        <!-- 建单方式（仅新建） -->
        <el-col v-if="!isChange" :span="24">
          <el-form-item :label="t('orders.sourceMode')">
            <el-radio-group v-model="form.sourceMode">
              <el-radio-button value="quote">{{ t('orders.sourceFromQuote') }}</el-radio-button>
              <el-radio-button value="manual">{{ t('orders.sourceManual') }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </el-col>

        <!-- 转单：选择已成交报价 -->
        <el-col v-if="!isChange && form.sourceMode === 'quote'" :span="24">
          <el-form-item :label="t('orders.quoteNo')" prop="quoteId">
            <el-select
              v-model="form.quoteId"
              filterable
              :placeholder="t('orders.quotePlaceholder')"
            >
              <el-option
                v-for="quote in (wonQuotes?.items ?? []) as QuoteListItem[]"
                :key="quote.quoteId"
                :value="quote.quoteId"
                :label="`${quote.quoteNo} · ${quote.customerName} · ${quote.currency} ${quote.totalAmount}`"
              />
            </el-select>
          </el-form-item>
        </el-col>

        <!-- 手工建单：选择客户 -->
        <el-col v-if="!isChange && form.sourceMode === 'manual'" :span="12">
          <el-form-item :label="t('orders.customer')" prop="customerId">
            <el-select
              v-model="form.customerId"
              filterable
              :placeholder="t('orders.customerPlaceholder')"
            >
              <el-option
                v-for="item in (customers?.items ?? []) as CustomerItem[]"
                :key="item.customerId"
                :value="item.customerId"
                :label="item.companyName"
              />
            </el-select>
          </el-form-item>
        </el-col>

        <el-col :span="12">
          <el-form-item :label="t('orders.deliveryDate')" prop="deliveryDate">
            <el-date-picker
              v-model="form.deliveryDate"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>

        <!-- 币种仅手工建单可选（转单沿用报价币种） -->
        <el-col v-if="!isChange && form.sourceMode === 'manual'" :span="12">
          <el-form-item :label="t('orders.currency')">
            <el-select v-model="form.currency">
              <el-option v-for="code in CURRENCIES" :key="code" :value="code" :label="code" />
            </el-select>
          </el-form-item>
        </el-col>

        <el-col :span="12">
          <el-form-item :label="t('orders.paymentTerms')">
            <el-input
              v-model="form.paymentTerms"
              :placeholder="t('orders.paymentTermsPlaceholder')"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <!-- 明细行：转单由快照复制，故新建转单时隐藏 -->
      <template v-if="isChange || form.sourceMode === 'manual'">
        <el-divider content-position="left">
          {{ t('orders.items') }} · {{ t('orders.itemCount', { count: items.length }) }}
        </el-divider>
        <div v-for="(row, index) in items" :key="`item-${index}`" class="order-form__row">
          <el-select
            v-model="row.productId"
            filterable
            :placeholder="t('orders.productPlaceholder')"
            class="order-form__product"
          >
            <el-option
              v-for="item in (products?.items ?? []) as ProductListItem[]"
              :key="item.productId"
              :value="item.productId"
              :label="item.name"
            />
          </el-select>
          <el-input
            v-model.number="row.quantity"
            type="number"
            min="1"
            :placeholder="t('orders.quantity')"
            class="order-form__num"
          />
          <el-input
            v-model="row.unitPrice"
            :placeholder="t('orders.unitPrice')"
            class="order-form__num"
          />
          <el-button link type="danger" @click="items.splice(index, 1)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
        <el-button
          link
          type="primary"
          @click="items.push({ productId: '', quantity: undefined, unitPrice: '' })"
        >
          <el-icon><Plus /></el-icon>{{ t('orders.addItem') }}
        </el-button>
      </template>
    </el-form>

    <template #footer>
      <el-button @click="close">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ isChange ? t('orders.submitChange') : t('common.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.order-form {
  &__tip {
    margin-bottom: 12px;
  }

  &__row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  &__product {
    flex: 2;
    min-width: 0;
  }

  &__num {
    flex: 1;
    min-width: 0;
  }
}
</style>
