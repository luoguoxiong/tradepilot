import { HttpResponse } from 'msw'

/**
 * SSE mock 工具（接口 14 §3.4 事件契约）：
 * event 四类 log / progress / status / done，按 intervalMs 依次推送，供 useTaskStream 开发与测试。
 */
export interface SseEvent {
  event: 'log' | 'progress' | 'status' | 'done'
  data: unknown
}

export function sseResponse(events: SseEvent[], intervalMs = 200) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const { event, data } of events) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      controller.close()
    },
  })
  return new HttpResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
