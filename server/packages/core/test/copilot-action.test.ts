import { describe, expect, it } from 'vitest';

import {
  classifyCopilotAction,
  copilotNextActionType,
  copilotSuggestionKind,
} from '../src/copilot-action.js';

describe('classifyCopilotAction（06 FR-09 流程型建议识别）', () => {
  it('创建报价类文案 → create_quote（中文动词 + 报价宾语相邻）', () => {
    expect(classifyCopilotAction('创建报价单并发送给客户')).toBe('create_quote');
    expect(classifyCopilotAction('生成报价方案')).toBe('create_quote');
    expect(classifyCopilotAction('准备一份报价')).toBe('create_quote');
    expect(classifyCopilotAction('Create a quote for MOQ 500')).toBe('create_quote');
    expect(classifyCopilotAction('prepare quotation')).toBe('create_quote');
  });

  it('预约跟进类文案 → create_tasks（建 follow_up_task）', () => {
    expect(classifyCopilotAction('预约 3 天后跟进')).toBe('create_tasks');
    expect(classifyCopilotAction('安排一次回访')).toBe('create_tasks');
    expect(classifyCopilotAction('创建跟进任务')).toBe('create_tasks');
    expect(classifyCopilotAction('Schedule a follow-up call')).toBe('create_tasks');
  });

  it('内容型文案 → null（只含宾语、不含创建动词，避免误判）', () => {
    expect(classifyCopilotAction('回复报价范围')).toBeNull();
    expect(classifyCopilotAction('强调 MOQ 500 双起订')).toBeNull();
    expect(classifyCopilotAction('询问采购数量')).toBeNull();
    expect(classifyCopilotAction('推荐替代款产品')).toBeNull();
    expect(classifyCopilotAction('')).toBeNull();
  });

  it('「发送报价单」等既有内容型文案不变更语义（发送 ≠ 创建报价单）', () => {
    // P0 既有建议文案（m5-batch-a / m5-e1 夹具）：语义是「把报价讲清楚」，仍是 insert_draft 内容型
    expect(classifyCopilotAction('发送报价单')).toBeNull();
    expect(classifyCopilotAction('发送最新报价给客户')).toBeNull();
    expect(classifyCopilotAction('Send the quotation to the buyer')).toBeNull();
    // 但「创建 + 发送」组合里的创建动词仍能命中流程型
    expect(classifyCopilotAction('创建报价单并发送给客户')).toBe('create_quote');
  });

  it('同时含报价与跟进意图时，报价优先（前端按动作各自入按钮）', () => {
    // 「回复报价范围，并预约跟进」：无创建动词 → 归跟进
    expect(classifyCopilotAction('回复报价范围，并预约跟进')).toBe('create_tasks');
    expect(classifyCopilotAction('创建报价后预约跟进')).toBe('create_quote');
  });

  it('kind / nextAction 映射：process 建议与 04 下一步动作同源', () => {
    expect(copilotSuggestionKind('创建报价单')).toBe('process');
    expect(copilotSuggestionKind('回复报价范围')).toBe('content');
    expect(copilotNextActionType('创建报价单')).toBe('send_quote');
    expect(copilotNextActionType('预约 3 天后跟进')).toBe('follow_up');
    expect(copilotNextActionType('强调 MOQ 500 双起订')).toBeNull();
  });
});
