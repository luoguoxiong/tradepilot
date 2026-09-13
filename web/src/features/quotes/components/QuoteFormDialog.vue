<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'

import { createQuote, updateQuote } from '@/api/resources/quotes'
import { getCustomers, getCustomerContacts } from '@/api/resources/customers'
import { getProducts } from '@/api/resources/products'
import { handleApiError } from '@/api/error-handler'
import type { ContactListReq, CustomerItem, CustomerListReq } from '@/api/types/customers'
import type { ProductListItem, ProductListQuery } from '@/api/types/products'
import type { QuoteDetail, QuoteItemPayload, QuoteUpsertReq } from '@/api/types/quotes'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * QuoteFormDialog 新建/编辑报价（09 §3.1 / FR-01/FR-02）：
 * 报价头结构化字段全必填 + 明细行（产品/数量/单价）；
 * 前端按所选产品的 MOQ 做即时提示与提交前校验（服务端 42201 兜底）；
 * 编辑仅草稿可用（服务端 40901 兜底），明细按「整体替换」语义提交。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    mode?: 'create' | 'edit'
    quote?: QuoteDetail | null
  }>(),
  { mode: 'create', quote: null },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [quoteId: string]
}>()

const { t } = useI18n()

const formRef = ref<FormInstance>()
const submitting = ref(false)

interface ItemRow {
  productId: string
  quantity: number | undefined
  unitPrice: string
}

const form = reactive({
  customerId: '',
  contactId: '',
  currency: 'USD',
  incoterms: '',
  validUntil: '',
  paymentTerms: '',
  exchangeRate: '',
})

const items = ref<ItemRow[]>([])

// ===== 选项数据（客户 / 联系人 / 产品）=====
const { data: customers } = useQuery({
  queryKey: [...qk.quotes.all, 'form-customers'],
  queryFn: () => getCustomers({ page: 1, pageSize: 200 } as CustomerListReq),
  staleTime: staleTime.DICT,
})

const { data: products } = useQuery({
  queryKey: [...qk.quotes.all, 'form-products'],
  queryFn: () => getProducts({ page: 1, pageSize: 200 } as ProductListQuery),
  staleTime: staleTime.DICT,
})

const { data: contacts } = useQuery({
  queryKey: computed(() => [...qk.quotes.all, 'form-contacts', form.customerId]),
  queryFn: () => getCustomerContacts(form.customerId, { page: 1, pageSize: 50 } as ContactListReq),
  enabled: computed(() => Boolean(form.customerId)),
  staleTime: staleTime.DICT,
})

const productMap = computed(() => {
  const map = new Map<string, ProductListItem>()
  for (const product of products.value?.items ?? []) map.set(product.productId, product)
  return map
})

/** 有效期须晚于今天（09 §3.1） */
function validateValidUntil(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value) return callback(new Error(t('quotes.requiredValidUntil')))
  const today = new Date().toISOString().slice(0, 10)
  if (value <= today) return callback(new Error(t('quotes.validUntilPast')))
  return callback()
}

const rules = computed<FormRules>(() => ({
  customerId: [{ required: true, message: t('quotes.requiredCustomer'), trigger: 'change' }],
  incoterms: [{ required: true, message: t('quotes.requiredIncoterms'), trigger: 'blur' }],
  validUntil: [{ validator: validateValidUntil, trigger: 'change' }],
  paymentTerms: [{ required: true, message: t('quotes.requiredPaymentTerms'), trigger: 'blur' }],
}))

function moqHint(row: ItemRow): string {
  const moq = productMap.value.get(row.productId)?.moq
  return moq !== undefined ? t('quotes.moqHint', { moq }) : ''
}

function resetFromQuote() {
  const quote = props.quote
  if (props.mode === 'edit' && quote) {
    form.customerId = quote.customerId
    form.contactId = quote.contactId ?? ''
    form.currency = quote.currency
    form.incoterms = quote.incoterms
    form.validUntil = quote.validUntil
    form.paymentTerms = quote.paymentTerms
    form.exchangeRate = quote.exchangeRate.rate
    items.value = quote.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    }))
  } else {
    form.customerId = ''
    form.contactId = ''
    form.currency = 'USD'
    form.incoterms = ''
    form.validUntil = ''
    form.paymentTerms = ''
    form.exchangeRate = ''
    items.value = [{ productId: '', quantity: undefined, unitPrice: '' }]
  }
  formRef.value?.clearValidate()
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) resetFromQuote()
  },
)

function addItem() {
  items.value.push({ productId: '', quantity: undefined, unitPrice: '' })
}

function removeItem(index: number) {
  items.value.splice(index, 1)
}

/** 明细行本地校验（MOQ / 正数），返回是否通过 */
function validateItems(): boolean {
  if (items.value.length === 0) {
    ElMessage.error(t('quotes.requiredProduct'))
    return false
  }
  for (const row of items.value) {
    if (!row.productId) {
      ElMessage.error(t('quotes.requiredProduct'))
      return false
    }
    if (!row.quantity || row.quantity <= 0) {
      ElMessage.error(t('quotes.requiredQuantity'))
      return false
    }
    const moq = productMap.value.get(row.productId)?.moq
    if (moq !== undefined && row.quantity < moq) {
      ElMessage.error(`${t('quotes.quantity')} < MOQ ${moq}`)
      return false
    }
    if (!row.unitPrice.trim() || Number(row.unitPrice) <= 0) {
      ElMessage.error(t('quotes.requiredUnitPrice'))
      return false
    }
  }
  return true
}

function buildPayload(): QuoteUpsertReq {
  const payload: QuoteUpsertReq = {
    customerId: form.customerId,
    currency: form.currency.trim() || 'USD',
    incoterms: form.incoterms.trim(),
    validUntil: form.validUntil,
    paymentTerms: form.paymentTerms.trim(),
    items: items.value.map<QuoteItemPayload>((row) => ({
      productId: row.productId,
      quantity: Number(row.quantity),
      unitPrice: row.unitPrice.trim(),
    })),
  }
  if (form.contactId) payload.contactId = form.contactId
  if (form.exchangeRate.trim()) payload.exchangeRate = { rate: form.exchangeRate.trim() }
  return payload
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (!validateItems()) return
  submitting.value = true
  try {
    const payload = buildPayload()
    const resp =
      props.mode === 'edit' && props.quote
        ? await updateQuote(props.quote.quoteId, payload)
        : await createQuote(payload)
    ElMessage.success(props.mode === 'edit' ? t('quotes.updateSuccess') : t('quotes.createSuccess'))
    emit('saved', resp.quoteId)
    emit('update:modelValue', false)
  } catch (error) {
    // MOQ / 有效期 / 利润红线（42201）等：error-handler 已按错误码提示，表单保留供修正
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
    :title="props.mode === 'edit' ? t('quotes.formTitleEdit') : t('quotes.formTitleCreate')"
    width="900px"
    :close-on-click-modal="false"
    append-to-body
    @close="close"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item :label="t('quotes.customer')" prop="customerId">
            <el-select
              v-model="form.customerId"
              filterable
              :placeholder="t('quotes.requiredCustomer')"
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
          <el-form-item :label="t('quotes.contact')">
            <el-select v-model="form.contactId" clearable :disabled="!form.customerId">
              <el-option
                v-for="item in contacts?.items ?? []"
                :key="item.contactId"
                :value="item.contactId"
                :label="item.name"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('quotes.currency')">
            <el-input v-model="form.currency" maxlength="3" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('quotes.incoterms')" prop="incoterms">
            <el-input v-model="form.incoterms" :placeholder="t('quotes.incotermsPlaceholder')" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('quotes.validUntil')" prop="validUntil">
            <el-date-picker
              v-model="form.validUntil"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('quotes.exchangeRate')">
            <el-input v-model="form.exchangeRate" :placeholder="t('quotes.exchangeRateHint')" />
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item :label="t('quotes.paymentTerms')" prop="paymentTerms">
            <el-input
              v-model="form.paymentTerms"
              :placeholder="t('quotes.paymentTermsPlaceholder')"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <!-- 明细行（整体替换，09 §3.1） -->
      <el-divider content-position="left">
        {{ t('quotes.items') }} · {{ t('quotes.itemCount', { count: items.length }) }}
      </el-divider>
      <div v-for="(row, index) in items" :key="`item-${index}`" class="quote-form__row">
        <el-select
          v-model="row.productId"
          filterable
          :placeholder="t('quotes.productPlaceholder')"
          class="quote-form__product"
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
          :placeholder="t('quotes.quantity')"
          class="quote-form__num"
        />
        <el-input
          v-model="row.unitPrice"
          :placeholder="t('quotes.unitPrice')"
          class="quote-form__num"
        />
        <span class="quote-form__moq">{{ moqHint(row) }}</span>
        <el-button link type="danger" @click="removeItem(index)">
          <el-icon><Delete /></el-icon>
        </el-button>
      </div>
      <el-button link type="primary" @click="addItem">
        <el-icon><Plus /></el-icon>{{ t('quotes.addItem') }}
      </el-button>
    </el-form>

    <template #footer>
      <el-button @click="close">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ t('common.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.quote-form {
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

  &__moq {
    flex-shrink: 0;
    width: 90px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
