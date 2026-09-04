<script setup lang="ts">
/**
 * /settings 设置：SMTP 发件配置（密码 write-only）+ 提醒规则
 */
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, type SettingsData } from '../api/client'

const loading = ref(false)
const testing = ref(false)
const saving = ref(false)
const loaded = ref(false)

const smtp = reactive({ host: '', port: 465, secure: true, user: '', pass: '', sender_name: '' })
const rules = reactive({ days_before: [7, 3, 1] as number[], deposit_days: 7, stalled_days: 14 })

async function load(): Promise<void> {
  loading.value = true
  try {
    const s: SettingsData = await api.getSettings()
    if (s.smtp) {
      smtp.host = s.smtp.host
      smtp.port = s.smtp.port
      smtp.secure = s.smtp.secure
      smtp.user = s.smtp.user
      smtp.sender_name = s.smtp.sender_name
    }
    rules.days_before = s.reminder_rules.days_before
    rules.deposit_days = s.reminder_rules.deposit_days
    rules.stalled_days = s.reminder_rules.stalled_days
    loaded.value = true
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await api.saveSettings({
      smtp: { host: smtp.host, port: Number(smtp.port) || 465, secure: smtp.secure, user: smtp.user, sender_name: smtp.sender_name, pass: smtp.pass || undefined },
      reminder_rules: { ...rules }
    })
    ElMessage.success('设置已保存')
    smtp.pass = ''
    await load()
  } finally {
    saving.value = false
  }
}

async function test(): Promise<void> {
  testing.value = true
  try {
    await api.testSmtp()
    ElMessage.success('SMTP 连接成功')
  } finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <h2 class="page-title">设置</h2>

    <el-card shadow="never" class="mb16">
      <template #header><b>邮件发送（SMTP）</b></template>
      <el-alert type="info" :closable="false" class="mb12"
        title="多数邮箱需使用「授权码」而非登录密码（如 QQ 邮箱在设置-账户中开启 SMTP 并生成授权码）。密码仅保存在本机数据库（加密存储），不会回显。" />
      <el-form label-width="120px" style="max-width: 640px">
        <el-form-item label="SMTP 主机">
          <el-input v-model="smtp.host" placeholder="如 smtp.qq.com" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number v-model="smtp.port" :min="1" :max="65535" controls-position="right" />
          <el-checkbox v-model="smtp.secure" label="SSL/TLS" class="ml16" />
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="smtp.user" placeholder="发件邮箱地址" />
        </el-form-item>
        <el-form-item label="授权码">
          <el-input v-model="smtp.pass" type="password" show-password
            :placeholder="loaded && smtp.host ? '已保存（输入新值可更新）' : '授权码'" />
        </el-form-item>
        <el-form-item label="发件人显示名">
          <el-input v-model="smtp.sender_name" placeholder="如 Lily / Shenzhen XX Trading Co., Ltd" />
        </el-form-item>
        <el-form-item>
          <el-button :loading="testing" @click="test">测试连接</el-button>
          <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header><b>提醒规则</b></template>
      <el-form label-width="140px" style="max-width: 640px">
        <el-form-item label="交期前提醒(天)">
          <el-select v-model="rules.days_before" multiple multiple-limit="5" style="width: 240px">
            <el-option v-for="d in [1, 2, 3, 5, 7, 10, 14, 21, 30]" :key="d" :label="`${d} 天前`" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="定金跟进阈值">
          <el-input-number v-model="rules.deposit_days" :min="1" :max="90" controls-position="right" />
          <span class="unit">天未记录定金到账则提醒</span>
        </el-form-item>
        <el-form-item label="停滞提醒阈值">
          <el-input-number v-model="rules.stalled_days" :min="1" :max="180" controls-position="right" />
          <span class="unit">天无进度更新则提醒</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存规则</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.page-title { margin: 8px 0 12px; font-size: 20px; }
.mb16 { margin-bottom: 16px; }
.mb12 { margin-bottom: 12px; }
.ml16 { margin-left: 16px; }
.unit { color: #6b7280; font-size: 12px; margin-left: 8px; }
</style>
