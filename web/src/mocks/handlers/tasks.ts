import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'

import { mockTasks, syncTasks, taskSnapshot } from '../data/business'
import { LATENCY, fail, ok } from '../utils'

const encoder = new TextEncoder()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** 14-AI任务中心（P0 范围）：详情 / 增量日志 / SSE 实时流 / 失败重试 */
export const taskHandlers = [
  http.get('/api/v1/tasks/:taskId', async ({ params }) => {
    await delay(150)
    const task = mockTasks.get(String(params.taskId))
    if (!task) return fail(ErrorCode.NOT_FOUND, '任务不存在')
    return ok(taskSnapshot(task))
  }),

  http.get('/api/v1/tasks/:taskId/logs', async ({ request, params }) => {
    await delay(120)
    const task = mockTasks.get(String(params.taskId))
    if (!task) return fail(ErrorCode.NOT_FOUND, '任务不存在')

    const url = new URL(request.url)
    const after = url.searchParams.get('after') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? 50)

    syncTasks()
    const elapsed = task.completed ? task.durationMs : Math.max(0, Date.now() - task.startedAt)
    const logs = task.script
      .filter((e) => e.event === 'log' && e.atMs <= elapsed)
      .map((e) => e.data)
    const fromIndex = after
      ? logs.findIndex((l) => (l as { logId: string }).logId === after) + 1
      : 0
    const items = fromIndex > 0 ? logs.slice(fromIndex, fromIndex + limit) : logs.slice(0, limit)
    const hasMore = fromIndex + items.length < logs.length

    return ok({ items, hasMore })
  }),

  // SSE 实时流（14 §3.4）：按脚本时序重放全部事件（客户端 logId 去重，重连窗口不丢不重）
  http.get('/api/v1/tasks/:taskId/stream', async ({ params, request }) => {
    const task = mockTasks.get(String(params.taskId))
    if (!task) return fail(ErrorCode.NOT_FOUND, '任务不存在')

    syncTasks()
    const startedAt = Date.now()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const item of task.script) {
          const wait = item.atMs - (Date.now() - startedAt)
          if (wait > 0) await sleep(wait)
          if (request.signal.aborted) {
            controller.close()
            return
          }
          const data =
            item.event === 'log' ? { ...item.data, time: new Date().toISOString() } : item.data
          // 与后端 SSE 契约对齐（04 §6.1）：data 恒为 { type, payload } 包裹
          controller.enqueue(sseChunk(item.event, { type: item.event, payload: data }))
          if (item.event === 'done') syncTasks() // 到达 done：落终态 + 注入线索
        }
        controller.close()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }),

  http.post('/api/v1/tasks/:taskId/retry', async ({ params }) => {
    await delay(LATENCY)
    const task = mockTasks.get(String(params.taskId))
    if (!task) return fail(ErrorCode.NOT_FOUND, '任务不存在')
    if (task.status !== 'failed') return fail(ErrorCode.CONFLICT, '仅失败任务可重试')

    // 重试 = 新一轮执行（保留原任务行；MVP mock：重置时序重跑）
    task.status = 'running'
    task.completed = false
    task.completedAt = null
    task.startedAt = Date.now()
    task.error = undefined
    return ok({ taskId: task.taskId, status: 'running' })
  }),
]
