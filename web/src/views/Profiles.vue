<script setup lang="ts">
/**
 * /profiles 产品档案：列表 + 新建/编辑（name, product_desc, keywords, markets, advantages）
 */
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, normalizeList, type Profile, type ProfilePayload } from '../api/client'
import { useProfileStore } from '../stores/profile'

const store = useProfileStore()

const list = ref<Profile[]>([])
const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
/** null = 新建，否则为编辑的档案 id */
const editingId = ref<number | null>(null)

const EMPTY_FORM: ProfilePayload = {
  name: '',
  product_desc: '',
  keywords: '',
  markets: '',
  advantages: ''
}
const form = reactive<ProfilePayload>({ ...EMPTY_FORM })

async function load(): Promise<void> {
  loading.value = true
  try {
    list.value = normalizeList<Profile>(await api.listProfiles())
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

/** 打开新建弹窗 */
function openCreate(): void {
  editingId.value = null
  Object.assign(form, EMPTY_FORM)
  dialogVisible.value = true
}

/** 打开编辑弹窗 */
function openEdit(p: Profile): void {
  editingId.value = p.id
  Object.assign(form, {
    name: p.name,
    product_desc: p.product_desc,
    keywords: p.keywords,
    markets: p.markets,
    advantages: p.advantages
  })
  dialogVisible.value = true
}

/** 保存（新建或更新） */
async function save(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写档案名称')
    return
  }
  saving.value = true
  try {
    if (editingId.value == null) {
      const created = await api.createProfile({ ...form })
      store.setCurrent(created.id)
      ElMessage.success('档案已创建并设为当前档案')
    } else {
      await api.updateProfile(editingId.value, { ...form })
      ElMessage.success('档案已保存')
    }
    dialogVisible.value = false
    await load()
    await store.fetch(true)
  } finally {
    saving.value = false
  }
}

/** 删除档案（当前档案被删除时由 store 自动回退到第一个） */
async function remove(p: Profile): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除档案「${p.name}」？该档案下的线索不受影响。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  await api.deleteProfile(p.id)
  await load()
  await store.fetch(true)
  ElMessage.success('已删除')
}

/** 设为当前档案 */
function setCurrent(p: Profile): void {
  store.setCurrent(p.id)
  ElMessage.success(`已切换到档案：${p.name}`)
}
</script>

<template>
  <div>
    <div class="card">
      <h2>
        我的产品档案
        <span class="badge">全部客户分析与开发信将基于当前档案</span>
      </h2>
      <div class="actions" style="margin: 0 0 12px">
        <el-button type="primary" @click="openCreate">＋ 新建产品档案</el-button>
      </div>

      <el-table :data="list" v-loading="loading" row-key="id" size="default">
        <el-table-column label="档案名称" min-width="160">
          <template #default="{ row }">
            <span class="cell-main">
              <b>{{ row.name }}</b>
            </span>
            <el-tag v-if="row.id === store.currentId" size="small" type="success" style="margin-left: 6px">
              当前
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="产品说明" prop="product_desc" min-width="220" show-overflow-tooltip />
        <el-table-column label="产品关键词" prop="keywords" min-width="200" show-overflow-tooltip />
        <el-table-column label="目标市场" prop="markets" min-width="130" show-overflow-tooltip />
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button
              size="small"
              type="primary"
              link
              :disabled="row.id === store.currentId"
              @click="setCurrent(row)"
            >
              设为当前
            </el-button>
            <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有产品档案，点击右上角「新建产品档案」开始" :image-size="80" />
        </template>
      </el-table>

      <div class="hint">档案配置一次，全部客户分析与开发信生成都将基于此档案。</div>
    </div>

    <!-- 新建/编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId == null ? '新建产品档案' : `编辑产品档案：${form.name}`"
      width="640px"
      destroy-on-close
    >
      <el-form label-width="120px" label-position="left">
        <el-form-item label="档案名称" required>
          <el-input v-model="form.name" placeholder="例如：不锈钢水杯 / 欧美市场" />
        </el-form-item>
        <el-form-item label="产品名称与说明">
          <el-input
            v-model="form.product_desc"
            type="textarea"
            :rows="3"
            placeholder="例如：304 不锈钢真空保温杯，容量 350ml–1L，支持激光刻字定制"
          />
        </el-form-item>
        <el-form-item label="产品关键词">
          <el-input
            v-model="form.keywords"
            placeholder="英文逗号分隔，例如：insulated water bottle, vacuum tumbler"
          />
          <div class="hint">用于匹配度评估与自动搜索客户。</div>
        </el-form-item>
        <el-form-item label="目标市场">
          <el-input v-model="form.markets" placeholder="例如：美国、德国、英国" />
        </el-form-item>
        <el-form-item label="差异化优势">
          <el-input
            v-model="form.advantages"
            type="textarea"
            :rows="2"
            placeholder="选填，用于开发信。例如：自有工厂 15 年，BSCI/ISO9001 认证，MOQ 500 件起"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存档案</el-button>
      </template>
    </el-dialog>
  </div>
</template>
