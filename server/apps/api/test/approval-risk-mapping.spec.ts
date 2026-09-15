import { describe, expect, it } from 'vitest';
import { APPROVAL_TYPE } from '@tradepilot/shared';
import { registerCrmTools, registerSearchTools, type ToolDefinition } from '@tradepilot/tools';
import { approvalTypeSchema } from '../src/approvals/approvals.dto.js';
import { highRiskApprovalTypes, mandatoryApprovalTypes } from '../src/settings/settings.dto.js';

/**
 * TC-APV-02 风险分级静态映射（12 §7.1 / 16 §1.7 approvalRules）纯单测：
 * - 6 类审批类型：quote / email_send / contract / order_change / bulk_marketing / customer_delete；
 * - high = quote / contract / customer_delete（永远人工审，禁 autoApprove）；
 * - medium = email_send / order_change / bulk_marketing（可开 autoApprove）；
 * - low（无 approvalType 的内置工具）不进审批中心。
 *
 * 交叉一致性来源：shared 枚举 ↔ 设置白名单（settings.dto）↔ 审核中心枚举（approvals.dto）
 * ↔ 内置工具 ToolDefinition（riskLevel/approvalType）。不依赖 docker 与外部凭据。
 */

const ALL_TOOLS: ToolDefinition[] = [];
registerSearchTools((t) => ALL_TOOLS.push(t));
registerCrmTools((t) => ALL_TOOLS.push(t));

describe('TC-APV-02 · 6 类审批风险分级静态映射', () => {
  it('mandatoryApprovalTypes = 6 类，与 shared APPROVAL_TYPE 枚举同源', () => {
    expect(mandatoryApprovalTypes).toHaveLength(6);
    expect([...mandatoryApprovalTypes].sort()).toEqual([...Object.values(APPROVAL_TYPE)].sort());
  });

  it('审核中心类型枚举与设置白名单一致（approvals.dto ↔ settings.dto）', () => {
    expect([...approvalTypeSchema.options].sort()).toEqual([...mandatoryApprovalTypes].sort());
  });

  it('high = quote / contract / customer_delete（永远人工审）', () => {
    expect([...highRiskApprovalTypes].sort()).toEqual(['contract', 'customer_delete', 'quote']);
  });

  it('medium = email_send / order_change / bulk_marketing，与 high 互斥且并集为全集', () => {
    const medium = mandatoryApprovalTypes.filter((t) => !highRiskApprovalTypes.includes(t));
    expect([...medium].sort()).toEqual(['bulk_marketing', 'email_send', 'order_change']);
    expect(medium).toHaveLength(3);
    // 并集 = 6 类全集，无遗漏无重复
    expect(new Set([...highRiskApprovalTypes, ...medium]).size).toBe(6);
  });

  it('内置工具：approvalType 均在 6 类白名单内，且 riskLevel 与静态映射一致', () => {
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(8);
    for (const tool of ALL_TOOLS) {
      if (!tool.approvalType) {
        continue;
      }
      expect(mandatoryApprovalTypes).toContain(tool.approvalType);
      const expected = highRiskApprovalTypes.includes(tool.approvalType) ? 'high' : 'medium';
      expect(tool.riskLevel).toBe(expected);
    }
  });

  it('email_send 工具为 medium（可开 autoApprove 的唯一 P0 外发动作）', () => {
    const emailSend = ALL_TOOLS.find((t) => t.name === 'email_send');
    expect(emailSend?.approvalType).toBe('email_send');
    expect(emailSend?.riskLevel).toBe('medium');
  });

  it('low 工具（无 approvalType）不进审批中心：只读/写池/知识检索/搜索抓站', () => {
    const noApproval = ALL_TOOLS.filter((t) => !t.approvalType);
    const names = noApproval.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'crm_read',
        'crm_write',
        'email_read',
        'knowledge_search',
        'web_search',
        'site_crawl',
        'find_contact',
        'lookup_contact',
        'lead_scoring',
      ]),
    );
    for (const tool of noApproval) {
      expect(tool.riskLevel).toBe('low');
    }
  });
});
