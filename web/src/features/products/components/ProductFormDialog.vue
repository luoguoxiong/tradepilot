<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'

import { createProduct, updateProduct } from '@/api/resources/products'
import { handleApiError } from '@/api/error-handler'
import { useDictStore } from '@/stores/dict'
import type { ProductDetail, ProductStatus, ProductUpsertReq } from '@/api/types/products'

/**
 * ProductFormDialog 添加/编辑产品（08 §1.7 / FR-02）：
 * 基础字段 + 规格键值对 + 阶梯价动态行；SKU 同企业唯一（42201 由 error-handler 统一提示）。
 * 编辑态以详情为初值；规格/阶梯价按「整体替换」语义提交。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** create = 添加；edit = 编辑（需传 product） */
    mode?: 'create' | 'edit'
    product?: ProductDetail | null
  }>(),
  { mode: 'create', product: null },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [productId: string]
}>()

const { t } = useI18n()
const dict = useDictStore()

const formRef = ref<FormInstance>()
const submitting = ref(false)

interface SpecRow {
  name: string
  value: string
  unit: string
}

interface TierRow {
  minQty: number | undefined
  unitPrice: string
}

const form = reactive({
  name: '',
  sku: '',
  category: '',
  image: '',
  moq: undefined as number | undefined,
  moqUnit: 'pcs',
  leadTimeDays: undefined as number | undefined,
  material: '',
  description: '',
  costPrice: '',
  currency: 'USD',
  suggestedPrice: '',
  status: 'draft' as ProductStatus,
})

const specs = ref<SpecRow[]>([])
const tiers = ref<TierRow[]>([])

const statusOptions = computed(() =>
  dict.options('productStatus').map((o) => ({ value: o.value, label: t(o.labelKey) })),
)

const rules = computed<FormRules>(() => ({
  name: [{ required: true, message: t('products.nameRequired'), trigger: 'blur' }],
  sku: [{ required: true, message: t('products.skuRequired'), trigger: 'blur' }],
  moq: [{ required: true, message: t('products.moqRequired'), trigger: 'blur' }],
  leadTimeDays: [{ required: true, message: t('products.leadTimeRequired'), trigger: 'blur' }],
  costPrice: [{ required: true, message: t('products.costPriceRequired'), trigger: 'blur' }],
}))

/** 从详情回填（编辑态）；新增态重置默认值 */
function resetFromProduct() {
  const p = props.product
  if (props.mode === 'edit' && p) {
    form.name = p.name
    form.sku = p.sku
    form.category = p.category ?? ''
    form.image = p.image ?? ''
    form.moq = p.moq
    form.moqUnit = p.moqUnit
    form.leadTimeDays = p.leadTimeDays
    form.material = p.material ?? ''
    form.description = p.description ?? ''
    form.costPrice = p.costPrice
    form.currency = p.currency
    form.suggestedPrice = p.suggestedPrice ?? ''
    form.status = p.status
    specs.value = p.specifications.map((s) => ({
      name: s.name,
      value: s.value,
      unit: s.unit ?? '',
    }))
    tiers.value = p.priceTiers.map((tier) => ({ minQty: tier.minQty, unitPrice: tier.unitPrice }))
  } else {
    form.name = ''
    form.sku = ''
    form.category = ''
    form.image = ''
    form.moq = undefined
    form.moqUnit = 'pcs'
    form.leadTimeDays = undefined
    form.material = ''
    form.description = ''
    form.costPrice = ''
    form.currency = 'USD'
    form.suggestedPrice = ''
    form.status = 'draft'
    specs.value = []
    tiers.value = []
  }
  formRef.value?.clearValidate()
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) resetFromProduct()
  },
)

function addSpec() {
  specs.value.push({ name: '', value: '', unit: '' })
}

function addTier() {
  tiers.value.push({ minQty: undefined, unitPrice: '' })
}

function removeSpec(index: number) {
  specs.value.splice(index, 1)
}

function removeTier(index: number) {
  tiers.value.splice(index, 1)
}

function buildPayload(): ProductUpsertReq {
  return {
    name: form.name.trim(),
    sku: form.sku.trim(),
    ...(form.category.trim() ? { category: form.category.trim() } : {}),
    ...(form.image.trim() ? { image: form.image.trim() } : {}),
    moq: Number(form.moq),
    moqUnit: form.moqUnit.trim() || 'pcs',
    leadTimeDays: Number(form.leadTimeDays),
    ...(form.material.trim() ? { material: form.material.trim() } : {}),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    costPrice: form.costPrice.trim(),
    currency: form.currency.trim() || 'USD',
    ...(form.suggestedPrice.trim() ? { suggestedPrice: form.suggestedPrice.trim() } : {}),
    status: form.status,
    specifications: specs.value
      .filter((s) => s.name.trim() && s.value.trim())
      .map((s) => ({
        name: s.name.trim(),
        value: s.value.trim(),
        ...(s.unit.trim() ? { unit: s.unit.trim() } : {}),
      })),
    priceTiers: tiers.value
      .filter((tier) => tier.minQty !== undefined && tier.unitPrice.trim())
      .map((tier) => ({ minQty: Number(tier.minQty), unitPrice: tier.unitPrice.trim() })),
  }
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const payload = buildPayload()
    const resp =
      props.mode === 'edit' && props.product
        ? await updateProduct(props.product.productId, payload)
        : await createProduct(payload)
    ElMessage.success(t('products.saveSuccess'))
    emit('saved', resp.productId)
    emit('update:modelValue', false)
  } catch (error) {
    // SKU 重复（42201）等：error-handler 已按错误码提示，表单保留供修正
    handleApiError(error, { fallback: t('products.saveFailed') })
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
    :title="props.mode === 'edit' ? t('products.formEditTitle') : t('products.formCreateTitle')"
    width="760px"
    :close-on-click-modal="false"
    append-to-body
    @close="close"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item :label="t('products.fieldName')" prop="name">
            <el-input v-model="form.name" maxlength="200" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldSku')" prop="sku">
            <el-input v-model="form.sku" maxlength="64" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldCategory')">
            <el-input v-model="form.category" maxlength="100" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldStatus')">
            <el-select v-model="form.status">
              <el-option
                v-for="option in statusOptions"
                :key="option.value"
                :value="option.value"
                :label="option.label"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldMoq')" prop="moq">
            <el-input v-model.number="form.moq" type="number" min="1" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldMoqUnit')">
            <el-input v-model="form.moqUnit" maxlength="20" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldLeadTime')" prop="leadTimeDays">
            <el-input v-model.number="form.leadTimeDays" type="number" min="0" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldMaterial')">
            <el-input v-model="form.material" maxlength="200" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldCostPrice')" prop="costPrice">
            <el-input v-model="form.costPrice" :placeholder="t('products.costPriceHint')" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldCurrency')">
            <el-input v-model="form.currency" maxlength="3" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldSuggestedPrice')">
            <el-input v-model="form.suggestedPrice" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item :label="t('products.fieldImage')">
            <el-input v-model="form.image" maxlength="1000" />
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item :label="t('products.fieldDescription')">
            <el-input v-model="form.description" type="textarea" :rows="3" maxlength="5000" />
          </el-form-item>
        </el-col>
      </el-row>

      <!-- 规格参数（键值对，整体替换） -->
      <el-divider content-position="left">{{ t('products.fieldSpecifications') }}</el-divider>
      <div v-for="(row, index) in specs" :key="`spec-${index}`" class="product-form__row">
        <el-input v-model="row.name" :placeholder="t('products.specName')" />
        <el-input v-model="row.value" :placeholder="t('products.specValue')" />
        <el-input v-model="row.unit" :placeholder="t('products.specUnit')" />
        <el-button link type="danger" @click="removeSpec(index)">
          <el-icon><Delete /></el-icon>
        </el-button>
      </div>
      <el-button link type="primary" @click="addSpec">
        <el-icon><Plus /></el-icon>{{ t('products.addSpec') }}
      </el-button>

      <!-- 阶梯价（起始数量唯一，整体替换） -->
      <el-divider content-position="left">{{ t('products.fieldPriceTiers') }}</el-divider>
      <div v-for="(row, index) in tiers" :key="`tier-${index}`" class="product-form__row">
        <el-input
          v-model.number="row.minQty"
          type="number"
          min="1"
          :placeholder="t('products.tierMinQty')"
        />
        <el-input v-model="row.unitPrice" :placeholder="t('products.tierUnitPrice')" />
        <el-button link type="danger" @click="removeTier(index)">
          <el-icon><Delete /></el-icon>
        </el-button>
      </div>
      <el-button link type="primary" @click="addTier">
        <el-icon><Plus /></el-icon>{{ t('products.addTier') }}
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
.product-form {
  &__row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
}
</style>
