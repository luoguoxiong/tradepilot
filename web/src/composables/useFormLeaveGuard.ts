import { ElMessageBox } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave } from 'vue-router'

export interface FormLeaveGuardOptions {
  /** 是否存在未保存变更（离开时据此决定是否拦截） */
  isDirty: () => boolean
  /** 自定义确认文案（缺省 common.unsavedConfirm） */
  message?: string
}

/**
 * 02 §6：表单类页面（策略编辑 / 报价编辑 / 设置表单等）离开时
 * onBeforeRouteLeave 拦截未保存变更 —— 确认「放弃更改」才放行，取消则停留当前页。
 * 页面自行维护 dirty 状态：表单变更置脏、保存成功后复位。
 */
export function useFormLeaveGuard(options: FormLeaveGuardOptions): void {
  const { t } = useI18n()

  onBeforeRouteLeave(async () => {
    if (!options.isDirty()) return true
    try {
      await ElMessageBox.confirm(
        options.message ?? t('common.unsavedConfirm'),
        t('common.unsavedTitle'),
        {
          type: 'warning',
          confirmButtonText: t('common.discard'),
          cancelButtonText: t('common.cancel'),
        },
      )
      return true
    } catch {
      return false
    }
  })
}
