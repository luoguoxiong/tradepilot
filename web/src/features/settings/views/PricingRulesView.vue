<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { fetchPricingRules, updatePricingRules } from '@/api/resources/settings'
import { handleApiError } from '@/api/error-handler'
import {
  INCOTERMS_OPTIONS,
  PRICING_COST_ITEM_KEYS,
  type PricingCostItemKey,
  type PricingRules,
} from '@/api/types/settings'
import { usePermission } from '@/composables/usePermission'
import { useFormLeaveGuard } from '@/composables/useFormLeaveGuard'

/**
 * 产品与报价规则（16 FR-07 / §1.6 / §3.5，P1）：
 * org 单例配置，保存即生效；`profitFloorPct` 由服务端对报价提交做 100% 拦截（42201）。
 * 读取 admin+manager、写入仅 admin（与后端 @Roles 一致）；非管理员降级为只读。
 */
const { t } = useI18n()
const { isAdmin } = usePermission()

const formRef = ref<FormInstance>()
const loading = ref(false)
const saving = ref(false)

const COST_ITEM_LABEL_KEYS: Record<PricingCostItemKey, string> = {
  purchase: 'settings.costItemPurchase',
  freight: 'settings.costItemFreight',
  insurance: 'settings.costItemInsurance',
  tax: 'settings.costItemTax',
  fx: 'settings.costItemFx',
}

const CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'AUD']

const form = reactive<PricingRules>({
  productCategories: [],
  costItems: [...PRICING_COST_ITEM_KEYS],
  profitFloorPct: 10,
  discountLadder: [3, 2, 1],
  defaultIncoterms: 'FOB',
  defaultCurrency: 'USD',
  exchangeRateSource: 'manual',
})

// 02 §6 表单离开拦截：加载完成后表单变更即置脏，保存成功复位
const loaded = ref(false)
const dirty = ref(false)
watch(
  form,
  () => {
    if (loaded.value && !saving.value) dirty.value = true
  },
  { deep: true },
)
useFormLeaveGuard({ isDirty: () => dirty.value })

const rules: FormRules = {
  costItems: [
    {
      validator: (_rule, value: string[], callback) => {
        callback(value && value.length > 0 ? undefined : new Error(t('settings.costItemsRequired')))
      },
      trigger: 'change',
    },
  ],
  profitFloorPct: [
    { required: true, message: t('settings.profitFloorPctRequired'), trigger: 'blur' },
  ],
  defaultCurrency: [
    { pattern: /^[A-Z]{3}$/, message: t('settings.currencyInvalid'), trigger: 'blur' },
  ],
}

onMounted(async () => {
  loading.value = true
  try {
    const result = await fetchPricingRules()
    Object.assign(form, result)
    loaded.value = true
  } catch (error) {
    handleApiError(error)
  } finally {
    loading.value = false
  }
})

function addLadder() {
  if (form.discountLadder.length >= 10) {
    ElMessage.warning(t('settings.ladderMax'))
    return
  }
  form.discountLadder.push(1)
}

function removeLadder(index: number) {
  form.discountLadder.splice(index, 1)
}

async function save() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const result = await updatePricingRules({
      productCategories: [...form.productCategories],
      costItems: [...form.costItems],
      profitFloorPct: form.profitFloorPct,
      discountLadder: [...form.discountLadder],
      defaultIncoterms: form.defaultIncoterms,
      defaultCurrency: form.defaultCurrency,
      exchangeRateSource: 'manual',
    })
    Object.assign(form, result)
    dirty.value = false
    ElMessage.success(t('settings.pricingRulesSaved'))
  } catch (error) {
    handleApiError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="pricing-rules">
    <el-alert
      class="pricing-rules__alert"
      type="info"
      :title="t('settings.pricingRulesHint')"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="!isAdmin"
      class="pricing-rules__alert"
      type="warning"
      :title="t('settings.adminOnlyHint')"
      :closable="false"
      show-icon
    />

    <el-form
      ref="formRef"
      v-loading="loading"
      class="pricing-rules__form"
      :model="form"
      :rules="rules"
      label-width="150px"
      :disabled="!isAdmin"
      @submit.prevent
    >
      <el-form-item :label="t('settings.productCategories')">
        <el-select
          v-model="form.productCategories"
          class="pricing-rules__wide"
          multiple
          filterable
          allow-create
          default-first-option
          :placeholder="t('settings.productCategoriesPlaceholder')"
        >
          <el-option
            v-for="category in form.productCategories"
            :key="category"
            :value="category"
            :label="category"
          />
        </el-select>
        <span class="pricing-rules__hint">{{ t('settings.productCategoriesHint') }}</span>
      </el-form-item>

      <el-form-item :label="t('settings.costItems')" prop="costItems">
        <el-checkbox-group v-model="form.costItems">
          <el-checkbox v-for="key in PRICING_COST_ITEM_KEYS" :key="key" :value="key">
            {{ t(COST_ITEM_LABEL_KEYS[key]) }}
          </el-checkbox>
        </el-checkbox-group>
        <span class="pricing-rules__hint">{{ t('settings.costItemsHint') }}</span>
      </el-form-item>

      <el-form-item :label="t('settings.profitFloorPct')" prop="profitFloorPct">
        <el-input-number
          v-model="form.profitFloorPct"
          :min="0"
          :max="100"
          :step="0.5"
          :precision="2"
          controls-position="right"
        />
        <span class="pricing-rules__hint">{{ t('settings.profitFloorPctHint') }}</span>
      </el-form-item>

      <el-form-item :label="t('settings.discountLadder')">
        <div class="pricing-rules__ladder">
          <div
            v-for="(_, index) in form.discountLadder"
            :key="index"
            class="pricing-rules__ladder-row"
          >
            <el-input-number
              v-model="form.discountLadder[index]"
              :min="1"
              :max="100"
              :step="1"
              :precision="0"
              controls-position="right"
            />
            <el-button link type="danger" @click="removeLadder(index)">
              {{ t('common.delete') }}
            </el-button>
          </div>
          <el-button link type="primary" @click="addLadder">
            {{ t('settings.addLadderStep') }}
          </el-button>
        </div>
        <span class="pricing-rules__hint">{{ t('settings.discountLadderHint') }}</span>
      </el-form-item>

      <el-form-item :label="t('settings.defaultIncoterms')" prop="defaultIncoterms">
        <el-select v-model="form.defaultIncoterms">
          <el-option
            v-for="incoterm in INCOTERMS_OPTIONS"
            :key="incoterm"
            :value="incoterm"
            :label="incoterm"
          />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('settings.defaultCurrency')" prop="defaultCurrency">
        <el-select v-model="form.defaultCurrency" filterable allow-create>
          <el-option
            v-for="currency in CURRENCIES"
            :key="currency"
            :value="currency"
            :label="currency"
          />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('settings.exchangeRateSource')">
        <el-tag type="info" effect="plain">{{ t('settings.exchangeRateSourceManual') }}</el-tag>
        <span class="pricing-rules__hint">{{ t('settings.exchangeRateSourceHint') }}</span>
      </el-form-item>

      <el-form-item>
        <el-button v-permission.disabled="['admin']" type="primary" :loading="saving" @click="save">
          {{ t('common.save') }}
        </el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped lang="scss">
.pricing-rules {
  max-width: 720px;

  &__alert {
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__wide {
    width: 100%;
  }

  &__hint {
    margin-left: 12px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__ladder {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__ladder-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
}
</style>
