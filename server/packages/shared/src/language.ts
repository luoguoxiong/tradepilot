/**
 * 邮件语言检测（06 §7 / LangGraph 工作流 §3.1：回复语言跟随最近一条 in 消息，
 * message.language 有值时以落库值为准，缺失时按正文确定性检测 zh/en，无信号默认英文）。
 * 确定性纯函数（无 AI 判断）：CJK 字符占比 ≥ 阈值判 zh，否则 en——
 * 与 email 同步链路（M4-4 落库 message.language）共用同一实现，杜绝双口径。
 */

/** CJK 统一表意文字 + 中文标点（U+3000~U+303F）与全角字符（U+FF00~U+FFEF） */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;

/** CJK 占比阈值：正文混排少量中文（如签名）不应翻转语言，10% 起判中文 */
const ZH_RATIO_THRESHOLD = 0.1;

/**
 * 按正文检测邮件语言（zh/en 二值，P0 口径）。
 * 空正文 / 无 CJK 信号 → 'en'（06 §7：无信号默认英文）。
 */
export function detectEmailLanguage(body: string | null | undefined): 'zh' | 'en' {
  if (!body) {
    return 'en';
  }
  const cjk = body.match(CJK_RE)?.length ?? 0;
  if (cjk === 0) {
    return 'en';
  }
  // 分母剔除空白，避免长英文邮件夹一行中文时占比被稀释误判
  const nonSpace = body.replace(/\s/g, '').length;
  if (nonSpace === 0) {
    return 'en';
  }
  return cjk / nonSpace >= ZH_RATIO_THRESHOLD ? 'zh' : 'en';
}
