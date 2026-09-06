<script setup lang="ts">
/** 登录 / 注册 / 企业初始化向导的空白布局（02 §1.2） */
</script>

<template>
  <div class="blank-layout">
    <router-view />
  </div>
</template>

<style scoped lang="scss">
.blank-layout {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(160deg, var(--tp-bg-page) 0%, #e8effd 100%);
}
</style>
