<script setup lang="ts">
/**
 * 应用骨架：顶栏（⚓ TradePilot + 产品档案切换下拉）+ 步骤导航（①②③）
 */
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useProfileStore } from './stores/profile'

const route = useRoute()
const router = useRouter()
const store = useProfileStore()
const { profiles, current } = storeToRefs(store)

onMounted(() => {
  void store.fetch()
})

/** 当前激活的步骤：1=产品档案 2=找客户 3=线索列表（详情/开发信页归入 ③） */
const activeStep = computed(() => {
  if (route.path.startsWith('/prospecting')) return 2
  if (route.path.startsWith('/leads')) return 3
  return 1
})

/** 档案下拉双向绑定：选「0」跳转档案管理页 */
const selectedProfileId = computed<number | undefined>({
  get: () => current.value?.id ?? undefined,
  set: (v) => {
    if (!v) {
      router.push('/profiles')
      return
    }
    store.setCurrent(v)
  }
})
</script>

<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar">
      <h1><span class="logo">⚓</span>TradePilot · 智能客户开发</h1>
      <el-select
        v-model="selectedProfileId"
        class="profile-select"
        placeholder="选择产品档案"
      >
        <el-option
          v-for="p in profiles"
          :key="p.id"
          :label="`产品档案：${p.name}`"
          :value="p.id"
        />
        <el-option label="＋ 新建 / 管理产品档案" :value="0" />
      </el-select>
    </header>

    <div class="container">
      <!-- 步骤导航 -->
      <nav class="stepnav">
        <button :class="{ active: activeStep === 1 }" @click="router.push('/profiles')">
          ① 产品档案
        </button>
        <button :class="{ active: activeStep === 2 }" @click="router.push('/prospecting')">
          ② 找客户
        </button>
        <button :class="{ active: activeStep === 3 }" @click="router.push('/leads')">
          ③ 线索列表
        </button>
      </nav>

      <router-view />
    </div>
  </div>
</template>
