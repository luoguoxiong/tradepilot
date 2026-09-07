-- 0002 · 全表列注释（COMMENT ON COLUMN）
-- 背景：drizzle-orm 暂不支持 schema 层列注释（issue #5203），故以 manual 迁移承载。
-- 约定：新增/改名列时须同步维护本文件的对应语句；COMMENT ON 天然幂等，
--       且本文件经 schema_manual_migrations 跟踪表防重放（见 src/migrate.ts）。

-- ============ ER 01 · 企业与用户设置 ============

-- org
COMMENT ON COLUMN org.id IS '雪花 ID（应用层 createId 生成，无 DB 默认值）';
COMMENT ON COLUMN org.name IS '企业名称';
COMMENT ON COLUMN org.logo_url IS '企业 Logo 图片 URL';
COMMENT ON COLUMN org.country IS '企业所在国家（ISO 国家代码）';
COMMENT ON COLUMN org.timezone IS 'IANA 时区（默认 Asia/Shanghai）：发送窗口/定时任务/报告周期/「今天待执行」统一基准';
COMMENT ON COLUMN org.default_language IS '默认界面语言（zh-CN / en）';
COMMENT ON COLUMN org.default_currency IS '默认币种 ISO 4217（如 USD），09 新报价默认';
COMMENT ON COLUMN org.industry IS '企业所属行业';
COMMENT ON COLUMN org.onboarding IS '初始化向导断点续走 { currentStep, steps[] }（16 §1.2）';
COMMENT ON COLUMN org.send_rules IS '外发规则 { sendWindow, minTouchIntervalDays }（16 FR-12，默认 09:00-18:00 / 3 天）';
COMMENT ON COLUMN org.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN org.updated_at IS '更新时间（UTC）';

-- user_account
COMMENT ON COLUMN user_account.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN user_account.org_id IS '所属企业（MVP 单企业单归属）';
COMMENT ON COLUMN user_account.email IS '登录邮箱（全局唯一，一律 toLowerCase 后入库比对）';
COMMENT ON COLUMN user_account.password_hash IS '密码哈希；invited 占位账号为 invite-placeholder: 前缀（不可登录，防重复接受邀请）';
COMMENT ON COLUMN user_account.name IS '用户姓名';
COMMENT ON COLUMN user_account.role IS '角色 admin / manager / sales';
COMMENT ON COLUMN user_account.status IS '账号状态（默认 invited，接受邀请后 active）';
COMMENT ON COLUMN user_account.invited_by IS '邀请人用户 ID（usr_）';
COMMENT ON COLUMN user_account.invited_at IS '邀请发起时间';
COMMENT ON COLUMN user_account.joined_at IS '接受邀请加入时间';
COMMENT ON COLUMN user_account.last_login_at IS '最近登录时间';
COMMENT ON COLUMN user_account.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN user_account.updated_at IS '更新时间（UTC）';

-- role_permission
COMMENT ON COLUMN role_permission.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN role_permission.org_id IS '所属企业';
COMMENT ON COLUMN role_permission.role IS '角色（org 内唯一，upsert 口径）';
COMMENT ON COLUMN role_permission.permissions IS '权限矩阵 jsonb（16 §1.7）';
COMMENT ON COLUMN role_permission.approval_rules IS '审批规则数组 { approvalType, approverRoles }';
COMMENT ON COLUMN role_permission.updated_by IS '最近修改人用户 ID';
COMMENT ON COLUMN role_permission.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN role_permission.updated_at IS '更新时间（UTC）';

-- mailbox
COMMENT ON COLUMN mailbox.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN mailbox.org_id IS '所属企业';
COMMENT ON COLUMN mailbox.owner_user_id IS '归属用户 ID（空 = 企业公共邮箱）';
COMMENT ON COLUMN mailbox.provider IS '服务商 gmail / outlook / smtp_imap';
COMMENT ON COLUMN mailbox.account IS '邮箱账号（org 内 lower(account) 唯一）';
COMMENT ON COLUMN mailbox.imap IS 'IMAP 连接配置；credential_enc 为 AES-256-GCM 密文';
COMMENT ON COLUMN mailbox.smtp IS 'SMTP 连接配置；credential_enc 为 AES-256-GCM 密文';
COMMENT ON COLUMN mailbox.sync_scope IS '同步范围 { historyDays, folders }';
COMMENT ON COLUMN mailbox.status IS '连接状态 connected / error / disconnected';
COMMENT ON COLUMN mailbox.last_sync_at IS '最近一次同步时间';
COMMENT ON COLUMN mailbox.last_error IS '最近一次连接/同步错误信息';
COMMENT ON COLUMN mailbox.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN mailbox.updated_at IS '更新时间（UTC）';

-- crm_integration
COMMENT ON COLUMN crm_integration.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN crm_integration.org_id IS '所属企业';
COMMENT ON COLUMN crm_integration.provider IS '集成目标（如 hubspot）';
COMMENT ON COLUMN crm_integration.status IS '接入状态';
COMMENT ON COLUMN crm_integration.sync_direction IS '同步方向（push / pull / both）';
COMMENT ON COLUMN crm_integration.mapping IS '字段映射 jsonb';
COMMENT ON COLUMN crm_integration.last_sync_at IS '最近一次同步时间';
COMMENT ON COLUMN crm_integration.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN crm_integration.updated_at IS '更新时间（UTC）';

-- pricing_rule_setting
COMMENT ON COLUMN pricing_rule_setting.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN pricing_rule_setting.org_id IS '所属企业（org 内唯一，单行配置）';
COMMENT ON COLUMN pricing_rule_setting.product_categories IS '规则适用的产品分类列表';
COMMENT ON COLUMN pricing_rule_setting.cost_items IS '成本项清单（purchase/freight/insurance/tax/fx）';
COMMENT ON COLUMN pricing_rule_setting.profit_floor_pct IS '毛利率下限（%）';
COMMENT ON COLUMN pricing_rule_setting.discount_ladder IS '折扣阶梯（按数量分档的折扣百分数）';
COMMENT ON COLUMN pricing_rule_setting.default_incoterms IS '默认贸易术语（FOB / CIF 等）';
COMMENT ON COLUMN pricing_rule_setting.default_currency IS '默认报价币种 ISO 4217';
COMMENT ON COLUMN pricing_rule_setting.exchange_rate_source IS '汇率来源（MVP 固定 manual）';
COMMENT ON COLUMN pricing_rule_setting.updated_by IS '最近修改人用户 ID';
COMMENT ON COLUMN pricing_rule_setting.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN pricing_rule_setting.updated_at IS '更新时间（UTC）';

-- notification_setting
COMMENT ON COLUMN notification_setting.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN notification_setting.org_id IS '所属企业（org 内唯一，单行配置）';
COMMENT ON COLUMN notification_setting.channels IS '渠道聚合总开关 { site, email }（任一事件启用该渠道即为 true）';
COMMENT ON COLUMN notification_setting.events IS '事件 × 渠道开关矩阵（approval_pending / risk_alert / task_failed）';
COMMENT ON COLUMN notification_setting.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN notification_setting.updated_at IS '更新时间（UTC）';

-- ai_model_setting
COMMENT ON COLUMN ai_model_setting.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN ai_model_setting.org_id IS '所属企业';
COMMENT ON COLUMN ai_model_setting.scene IS '场景枚举 lead_hunting / email_reply / follow_up / analysis';
COMMENT ON COLUMN ai_model_setting.model IS '模型名（LLM 路由标识）';
COMMENT ON COLUMN ai_model_setting.temperature IS '采样温度（缺省 0.70）';
COMMENT ON COLUMN ai_model_setting.max_tokens IS '最大输出 token 数（缺省 4096）';
COMMENT ON COLUMN ai_model_setting.budget_limit IS '场景预算上限（USD）；超限仅告警不熔断，NULL = 不限';
COMMENT ON COLUMN ai_model_setting.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN ai_model_setting.updated_at IS '更新时间（UTC）';

-- api_key
COMMENT ON COLUMN api_key.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN api_key.org_id IS '所属企业';
COMMENT ON COLUMN api_key.name IS '密钥名称（用户自定义）';
COMMENT ON COLUMN api_key.key_prefix IS '密钥前缀（明文展示用于识别，不含完整密钥）';
COMMENT ON COLUMN api_key.key_hash IS '完整密钥哈希（全局唯一，原始密钥不落库）';
COMMENT ON COLUMN api_key.scopes IS '授权范围（scope 标识数组）';
COMMENT ON COLUMN api_key.status IS '状态 active / revoked';
COMMENT ON COLUMN api_key.created_by IS '创建人用户 ID';
COMMENT ON COLUMN api_key.last_used_at IS '最近使用时间';
COMMENT ON COLUMN api_key.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN api_key.updated_at IS '更新时间（UTC）';

-- webhook
COMMENT ON COLUMN webhook.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN webhook.org_id IS '所属企业';
COMMENT ON COLUMN webhook.url IS '回调接收地址（HTTPS）';
COMMENT ON COLUMN webhook.events IS '订阅的事件类型数组';
COMMENT ON COLUMN webhook.secret_enc IS '签名密钥（AES-256-GCM 密文，用于请求签名校验）';
COMMENT ON COLUMN webhook.status IS '状态 active / disabled';
COMMENT ON COLUMN webhook.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN webhook.updated_at IS '更新时间（UTC）';

-- ============ ER 02 · AI 员工与任务 ============

-- sop_template
COMMENT ON COLUMN sop_template.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN sop_template.org_id IS '所属企业';
COMMENT ON COLUMN sop_template.role IS '适用的 AI 员工角色';
COMMENT ON COLUMN sop_template.name IS 'SOP 模板名称';
COMMENT ON COLUMN sop_template.content IS 'SOP 内容：步骤/提示词/工具编排 + 高级设置（总纲 §4.3）';
COMMENT ON COLUMN sop_template.is_preset IS '是否预设模板（true 种子数据不可删，可复制编辑）';
COMMENT ON COLUMN sop_template.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN sop_template.updated_at IS '更新时间（UTC）';

-- ai_employee
COMMENT ON COLUMN ai_employee.id IS '雪花 ID（emp_ 前缀，应用层 createId 生成）';
COMMENT ON COLUMN ai_employee.org_id IS '所属企业';
COMMENT ON COLUMN ai_employee.role IS '员工角色 lead_hunter / sales / follow_up / merchandiser 等';
COMMENT ON COLUMN ai_employee.name IS '员工名称（展示名）';
COMMENT ON COLUMN ai_employee.avatar IS '头像图片 URL';
COMMENT ON COLUMN ai_employee.status IS '运行状态（默认 idle；working / waiting_approval / scheduled / risk / failed）';
COMMENT ON COLUMN ai_employee.status_detail IS '状态补充说明（卡片「正在做什么」一句话）';
COMMENT ON COLUMN ai_employee.goal IS '员工目标（岗位使命描述）';
COMMENT ON COLUMN ai_employee.sop_template_id IS '绑定的 SOP 模板 ID';
COMMENT ON COLUMN ai_employee.skills IS '技能标签数组';
COMMENT ON COLUMN ai_employee.tools IS '可用工具标识数组';
COMMENT ON COLUMN ai_employee.knowledge_scope IS '可检索的知识范围（知识文档 id 或分类标签）';
COMMENT ON COLUMN ai_employee.memory_config IS '记忆配置 { retentionDays（默认 180 天）, scope }';
COMMENT ON COLUMN ai_employee.workflow_id IS '绑定工作流标识（LangGraph 图 ID）';
COMMENT ON COLUMN ai_employee.permissions IS '工具/数据权限声明 jsonb';
COMMENT ON COLUMN ai_employee.approval_policy IS '审批策略（email_send=always/high_value_only、autoExecute 白名单）';
COMMENT ON COLUMN ai_employee.kpi_config IS 'KPI 配置 { metric, target, period }';
COMMENT ON COLUMN ai_employee.created_by IS '创建人用户 ID';
COMMENT ON COLUMN ai_employee.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN ai_employee.updated_at IS '更新时间（UTC）';

-- ai_task
COMMENT ON COLUMN ai_task.id IS '雪花 ID（task_ 前缀，应用层 createId 生成）';
COMMENT ON COLUMN ai_task.org_id IS '所属企业';
COMMENT ON COLUMN ai_task.employee_id IS '执行员工 ID（单员工并发=1 的调度键）';
COMMENT ON COLUMN ai_task.type IS '任务类型（决定 BullMQ 队列 q.<type>）';
COMMENT ON COLUMN ai_task.title IS '任务标题';
COMMENT ON COLUMN ai_task.status IS '任务状态（默认 scheduled；running 由 Runner.claim 置位并补 started_at；waiting_approval 不占并发）';
COMMENT ON COLUMN ai_task.progress_pct IS '进度百分比 0-100（check 约束）';
COMMENT ON COLUMN ai_task.current_step IS '当前步骤名称（员工卡片轻列表展示用，不落步骤表）';
COMMENT ON COLUMN ai_task.input IS '任务入参 jsonb';
COMMENT ON COLUMN ai_task.outputs IS '任务产出数组（含失败留存，如审批超时的草稿）';
COMMENT ON COLUMN ai_task.error IS '失败原因（终态 failed 时的错误信息）';
COMMENT ON COLUMN ai_task.linked_approval_id IS '关联审批单 ID（waiting_approval 溯源，FK 由 manual 迁移补齐）';
COMMENT ON COLUMN ai_task.retry_of IS '溯源：重新生成时指向原任务 ID（同 task_type 新建任务）';
COMMENT ON COLUMN ai_task.scheduled_at IS '计划执行时间';
COMMENT ON COLUMN ai_task.started_at IS '实际开始时间';
COMMENT ON COLUMN ai_task.finished_at IS '结束时间（completed / failed / canceled）';
COMMENT ON COLUMN ai_task.created_by IS '创建人用户 ID（定时任务为空）';
COMMENT ON COLUMN ai_task.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN ai_task.updated_at IS '更新时间（UTC）';

-- ai_task_step
COMMENT ON COLUMN ai_task_step.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN ai_task_step.org_id IS '所属企业';
COMMENT ON COLUMN ai_task_step.task_id IS '所属任务 ID';
COMMENT ON COLUMN ai_task_step.seq IS '步骤序号（task 内唯一，从 1 递增）';
COMMENT ON COLUMN ai_task_step.name IS '步骤名称';
COMMENT ON COLUMN ai_task_step.status IS '步骤状态（取 task_status 枚举子集）';
COMMENT ON COLUMN ai_task_step.started_at IS '步骤开始时间';
COMMENT ON COLUMN ai_task_step.finished_at IS '步骤结束时间';

-- ai_task_log
COMMENT ON COLUMN ai_task_log.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN ai_task_log.org_id IS '所属企业';
COMMENT ON COLUMN ai_task_log.task_id IS '所属任务 ID';
COMMENT ON COLUMN ai_task_log.occurred_at IS '事件发生时间（SSE 回放排序键）';
COMMENT ON COLUMN ai_task_log.type IS '日志类型 search / found / crawl / match / contact / lookup / error';
COMMENT ON COLUMN ai_task_log.content IS '日志内容（人类可读文本）';
COMMENT ON COLUMN ai_task_log.lead_id IS '关联线索 ID（found / contact 类日志可选）';
COMMENT ON COLUMN ai_task_log.created_at IS '入库时间（UTC）';

-- llm_call
COMMENT ON COLUMN llm_call.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN llm_call.org_id IS '所属企业';
COMMENT ON COLUMN llm_call.task_id IS '触发任务 ID（系统级调用为空）';
COMMENT ON COLUMN llm_call.employee_id IS '执行员工 ID（系统级调用为空）';
COMMENT ON COLUMN llm_call.node IS 'LangGraph 节点名';
COMMENT ON COLUMN llm_call.scene IS '模型场景 lead_hunting / email_reply / follow_up / analysis';
COMMENT ON COLUMN llm_call.model IS '实际调用模型名';
COMMENT ON COLUMN llm_call.prompt_tokens IS '输入 token 数';
COMMENT ON COLUMN llm_call.completion_tokens IS '输出 token 数';
COMMENT ON COLUMN llm_call.cost_usd IS '估算成本（USD）';
COMMENT ON COLUMN llm_call.latency_ms IS '调用耗时（毫秒）';
COMMENT ON COLUMN llm_call.degraded IS '是否降级调用（备用模型/重试后成功）';
COMMENT ON COLUMN llm_call.created_at IS '创建时间（UTC）';

-- ============ ER 03 · AI 获客 ============

-- ai_lead
COMMENT ON COLUMN ai_lead.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN ai_lead.org_id IS '所属企业';
COMMENT ON COLUMN ai_lead.task_id IS '产出来源任务 ID（手工添加为空）';
COMMENT ON COLUMN ai_lead.company_name IS '公司名称';
COMMENT ON COLUMN ai_lead.country IS '公司所在国家（ISO 国家代码）';
COMMENT ON COLUMN ai_lead.industry IS '所属行业';
COMMENT ON COLUMN ai_lead.website IS '公司官网 URL（原始值）';
COMMENT ON COLUMN ai_lead.company_domain IS '归一化域名（小写、去 www.，org 内唯一去重键，03 §3.6）';
COMMENT ON COLUMN ai_lead.match_pct IS '匹配度百分比 0-100';
COMMENT ON COLUMN ai_lead.score_level IS '价值分级 high / medium / low';
COMMENT ON COLUMN ai_lead.insight IS '匹配理由 { value, confidence, reasons[] }（接口总览 §4.1）';
COMMENT ON COLUMN ai_lead.overview IS '公司概况（规模/成立年份/主营产品等）';
COMMENT ON COLUMN ai_lead.analyzed_at IS 'AI 分析完成时间';
COMMENT ON COLUMN ai_lead.in_crm IS '是否已录入 CRM（true 后从待处理列表消失）';
COMMENT ON COLUMN ai_lead.converted_customer_id IS '转化后的客户 ID（in_crm=true 时回填，FK 由 manual 迁移补齐）';
COMMENT ON COLUMN ai_lead.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN ai_lead.updated_at IS '更新时间（UTC）';

-- ai_lead_contact
COMMENT ON COLUMN ai_lead_contact.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN ai_lead_contact.org_id IS '所属企业';
COMMENT ON COLUMN ai_lead_contact.lead_id IS '所属线索 ID';
COMMENT ON COLUMN ai_lead_contact.name IS '联系人姓名';
COMMENT ON COLUMN ai_lead_contact.title IS '职位';
COMMENT ON COLUMN ai_lead_contact.email IS '邮箱（小写比对）';
COMMENT ON COLUMN ai_lead_contact.decision_influence_pct IS '决策影响力百分比 0-100';
COMMENT ON COLUMN ai_lead_contact.source IS '信息来源（如官网 / hunter）';
COMMENT ON COLUMN ai_lead_contact.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN ai_lead_contact.updated_at IS '更新时间（UTC）';

-- ============ ER 04 · 客户与 CRM ============

-- customer
COMMENT ON COLUMN customer.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN customer.org_id IS '所属企业';
COMMENT ON COLUMN customer.company_name IS '客户公司名称（org 内 lower 唯一，仅未删除行）';
COMMENT ON COLUMN customer.country IS '客户所在国家（ISO 国家代码）';
COMMENT ON COLUMN customer.website IS '公司官网 URL';
COMMENT ON COLUMN customer.industry IS '所属行业';
COMMENT ON COLUMN customer.industry_tags IS '行业标签数组（AI 沉淀）';
COMMENT ON COLUMN customer.customer_type IS '客户类型 brand / distributor / factory / other';
COMMENT ON COLUMN customer.stage IS '跟进阶段（默认 new_lead）';
COMMENT ON COLUMN customer.is_formal IS '客户身份 false 潜在 / true 正式；AI 不得变更（05 §7）';
COMMENT ON COLUMN customer.score IS '客户评分 0-100（AI 洞察沉淀）';
COMMENT ON COLUMN customer.owner_id IS '负责人用户 ID（仅 manager/admin 可改，变更写 activity 留痕）';
COMMENT ON COLUMN customer.source_lead_id IS '来源获客线索 ID（从 03 一键入库时回填，FK 由 manual 迁移补齐）';
COMMENT ON COLUMN customer.next_action IS '建议下一步动作 { type, label, targetId }';
COMMENT ON COLUMN customer.remark IS '备注';
COMMENT ON COLUMN customer.delete_locked IS '删除保护（true 禁止删除，默认 false）';
COMMENT ON COLUMN customer.created_by IS '创建人用户 ID';
COMMENT ON COLUMN customer.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN customer.updated_at IS '更新时间（UTC）';
COMMENT ON COLUMN customer.deleted_at IS '软删时间（NULL = 未删除；唯一索引仅覆盖未删行）';

-- contact
COMMENT ON COLUMN contact.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN contact.org_id IS '所属企业';
COMMENT ON COLUMN contact.customer_id IS '所属客户 ID';
COMMENT ON COLUMN contact.name IS '联系人姓名';
COMMENT ON COLUMN contact.title IS '职位';
COMMENT ON COLUMN contact.email IS '邮箱（org 内 lower 唯一，收发信匹配键）';
COMMENT ON COLUMN contact.phone IS '电话';
COMMENT ON COLUMN contact.decision_influence_pct IS '决策影响力百分比 0-100';
COMMENT ON COLUMN contact.decision_influence_reasons IS '影响力判断理由数组 { text, evidence?, source? }';
COMMENT ON COLUMN contact.is_primary IS '是否主联系人（默认 false）';
COMMENT ON COLUMN contact.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN contact.updated_at IS '更新时间（UTC）';

-- customer_insight
COMMENT ON COLUMN customer_insight.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN customer_insight.org_id IS '所属企业';
COMMENT ON COLUMN customer_insight.customer_id IS '所属客户 ID';
COMMENT ON COLUMN customer_insight.insight_type IS '洞察类型（customer+type 唯一，最新覆盖）';
COMMENT ON COLUMN customer_insight.value IS '洞察数值（如购买概率，文本存储）';
COMMENT ON COLUMN customer_insight.confidence IS '置信度 0-1';
COMMENT ON COLUMN customer_insight.reasons IS '判断理由数组 { text, evidence?, source? }';
COMMENT ON COLUMN customer_insight.citations IS '引用来源（知识文档/分块）';
COMMENT ON COLUMN customer_insight.next_action IS '建议下一步动作 { type, label, targetId }';
COMMENT ON COLUMN customer_insight.task_id IS '生成该洞察的任务 ID';
COMMENT ON COLUMN customer_insight.generated_at IS 'AI 生成时间';
COMMENT ON COLUMN customer_insight.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN customer_insight.updated_at IS '更新时间（UTC）';

-- customer_activity
COMMENT ON COLUMN customer_activity.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN customer_activity.org_id IS '所属企业';
COMMENT ON COLUMN customer_activity.customer_id IS '所属客户 ID';
COMMENT ON COLUMN customer_activity.type IS '动态类型 stage_change / owner_change / email / quote 等';
COMMENT ON COLUMN customer_activity.summary IS '动态摘要（一句话，时间线直接展示）';
COMMENT ON COLUMN customer_activity.operator_type IS '操作者类型 ai / user';
COMMENT ON COLUMN customer_activity.operator_id IS '操作者 ID（多态：emp_ 或 usr_ 前缀）';
COMMENT ON COLUMN customer_activity.operator_name IS '操作者名称快照（防改名影响历史）';
COMMENT ON COLUMN customer_activity.ref_type IS '关联对象类型（quotation / message 等，可选）';
COMMENT ON COLUMN customer_activity.ref_id IS '关联对象 ID（可选）';
COMMENT ON COLUMN customer_activity.created_at IS '发生时间（UTC）';

-- ============ ER 05 · 销售邮件与自动跟进 ============

-- conversation
COMMENT ON COLUMN conversation.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN conversation.org_id IS '所属企业';
COMMENT ON COLUMN conversation.customer_id IS '关联客户 ID';
COMMENT ON COLUMN conversation.contact_id IS '关联联系人 ID（可空）';
COMMENT ON COLUMN conversation.channel IS '会话渠道（MVP 仅 email）';
COMMENT ON COLUMN conversation.subject IS '会话主题（取首封/最新邮件主题）';
COMMENT ON COLUMN conversation.priority IS 'AI 判定优先级 high / normal / pending';
COMMENT ON COLUMN conversation.unread_count IS '未读消息数';
COMMENT ON COLUMN conversation.last_message_at IS '最近一条消息时间（列表排序键）';
COMMENT ON COLUMN conversation.last_message_preview IS '最近一条消息预览文本';
COMMENT ON COLUMN conversation.mailbox_id IS '来源邮箱 ID（多邮箱来源标识）';
COMMENT ON COLUMN conversation.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN conversation.updated_at IS '更新时间（UTC）';

-- message
COMMENT ON COLUMN message.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN message.org_id IS '所属企业';
COMMENT ON COLUMN message.conversation_id IS '所属会话 ID';
COMMENT ON COLUMN message.direction IS '收发方向 in 来信 / out 去信';
COMMENT ON COLUMN message.sender_type IS '发送方 ai / user / contact';
COMMENT ON COLUMN message.sender_name IS '发送方名称快照';
COMMENT ON COLUMN message.mailbox_id IS '收发邮箱 ID（external 去重键组成部分）';
COMMENT ON COLUMN message.content IS '消息正文（纯文本）';
COMMENT ON COLUMN message.language IS '消息语言（来信检测 / 草稿生成语言，跟随最近一条 in 消息，06 §7）';
COMMENT ON COLUMN message.status IS '状态 draft / sent / failed';
COMMENT ON COLUMN message.citations IS '草稿引用来源 { docId, docName?, chunkId? }';
COMMENT ON COLUMN message.based_on_message_id IS '基于哪条来信生成的草稿（自引用）';
COMMENT ON COLUMN message.edited_diff IS '人工编辑差异 [{ field, before, after }]';
COMMENT ON COLUMN message.external_message_id IS '邮件服务商 Message-ID（mailbox 内唯一，同步去重）';
COMMENT ON COLUMN message.sent_at IS '发送时间（status=sent 时回填）';
COMMENT ON COLUMN message.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN message.updated_at IS '更新时间（UTC）';

-- conversation_insight
COMMENT ON COLUMN conversation_insight.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN conversation_insight.org_id IS '所属企业';
COMMENT ON COLUMN conversation_insight.conversation_id IS '所属会话 ID（唯一，最新覆盖）';
COMMENT ON COLUMN conversation_insight.intent IS 'AI 判定意图 rfq / price_compare / logistics / sample / other';
COMMENT ON COLUMN conversation_insight.purchase_probability IS '购买概率 0-100';
COMMENT ON COLUMN conversation_insight.suggestions IS '建议动作数组 { suggestionId, label }（发起类，可生成任务/插草稿）';
COMMENT ON COLUMN conversation_insight.citations IS '引用来源 { docId, docName?, chunkId? }';
COMMENT ON COLUMN conversation_insight.generated_at IS 'AI 生成时间';
COMMENT ON COLUMN conversation_insight.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN conversation_insight.updated_at IS '更新时间（UTC）';

-- follow_up_strategy
COMMENT ON COLUMN follow_up_strategy.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN follow_up_strategy.org_id IS '所属企业';
COMMENT ON COLUMN follow_up_strategy.name IS '策略名称';
COMMENT ON COLUMN follow_up_strategy.target_scope IS '适用客户范围筛选条件 jsonb';
COMMENT ON COLUMN follow_up_strategy.auto_send_policy IS '自动发送策略 manual_review / auto_send / value_based';
COMMENT ON COLUMN follow_up_strategy.enabled IS '是否启用（默认 true）';
COMMENT ON COLUMN follow_up_strategy.is_default IS '是否默认策略（种子数据不可删，可复制编辑）';
COMMENT ON COLUMN follow_up_strategy.created_by IS '创建人用户 ID';
COMMENT ON COLUMN follow_up_strategy.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN follow_up_strategy.updated_at IS '更新时间（UTC）';

-- follow_up_strategy_step
COMMENT ON COLUMN follow_up_strategy_step.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN follow_up_strategy_step.org_id IS '所属企业';
COMMENT ON COLUMN follow_up_strategy_step.strategy_id IS '所属策略 ID';
COMMENT ON COLUMN follow_up_strategy_step.seq IS '步骤序号（strategy 内唯一）';
COMMENT ON COLUMN follow_up_strategy_step.day_offset IS '相对触发日的偏移天数（strategy 内唯一）';
COMMENT ON COLUMN follow_up_strategy_step.title IS '步骤标题';
COMMENT ON COLUMN follow_up_strategy_step.template_id IS '引用邮件模板（知识文档 ID，可选）';
COMMENT ON COLUMN follow_up_strategy_step.content IS '步骤正文/生成指令（可选）';
COMMENT ON COLUMN follow_up_strategy_step.channel IS '触达渠道（MVP 仅 email）';
COMMENT ON COLUMN follow_up_strategy_step.is_breakup IS '是否 Break-up Email（强制人工审批）';
COMMENT ON COLUMN follow_up_strategy_step.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN follow_up_strategy_step.updated_at IS '更新时间（UTC）';

-- follow_up_task
COMMENT ON COLUMN follow_up_task.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN follow_up_task.org_id IS '所属企业';
COMMENT ON COLUMN follow_up_task.customer_id IS '目标客户 ID（org+customer+strategy 唯一：一客户一策略一任务）';
COMMENT ON COLUMN follow_up_task.strategy_id IS '应用的策略 ID';
COMMENT ON COLUMN follow_up_task.current_stage IS '当前阶段 follow_up_1..3 / quote_followup';
COMMENT ON COLUMN follow_up_task.next_run_at IS '下次执行时间（UTC；恒满足频控+窗口约束，单一写入口 = Scheduler 预检 + schedule_next）';
COMMENT ON COLUMN follow_up_task.status IS '任务状态（Scheduler 仅扫 ready/scheduled；waiting_approval 冻结 next_run_at）';
COMMENT ON COLUMN follow_up_task.last_executed_at IS '最近一次执行时间';
COMMENT ON COLUMN follow_up_task.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN follow_up_task.updated_at IS '更新时间（UTC）';

-- follow_up_execution
COMMENT ON COLUMN follow_up_execution.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN follow_up_execution.org_id IS '所属企业';
COMMENT ON COLUMN follow_up_execution.follow_up_task_id IS '所属跟进任务 ID';
COMMENT ON COLUMN follow_up_execution.strategy_step_id IS '对应策略步骤 ID（客户已回复跳过时为空）';
COMMENT ON COLUMN follow_up_execution.step_title IS '步骤标题快照';
COMMENT ON COLUMN follow_up_execution.status IS '执行状态 sent / waiting_approval / approved / rejected / failed / skipped';
COMMENT ON COLUMN follow_up_execution.content IS 'AI 生成的内容快照（邮件正文）';
COMMENT ON COLUMN follow_up_execution.message_id IS '发送成功后关联的消息 ID';
COMMENT ON COLUMN follow_up_execution.approval_id IS '关联审批单 ID（waiting_approval 时回填，FK 由 manual 迁移补齐）';
COMMENT ON COLUMN follow_up_execution.approved_by IS '审批人用户 ID';
COMMENT ON COLUMN follow_up_execution.skip_reason IS '跳过原因 customer_replied / frequency_capped（07 §4 / §7）';
COMMENT ON COLUMN follow_up_execution.sent_at IS '实际发送时间';
COMMENT ON COLUMN follow_up_execution.created_at IS '创建时间（UTC）';

-- ============ ER 06 · 产品与知识 ============

-- product
COMMENT ON COLUMN product.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN product.org_id IS '所属企业';
COMMENT ON COLUMN product.sku IS 'SKU（org 内唯一；变体按独立产品行建模）';
COMMENT ON COLUMN product.name IS '产品名称';
COMMENT ON COLUMN product.category IS '产品分类';
COMMENT ON COLUMN product.image_url IS '主图 URL';
COMMENT ON COLUMN product.moq IS '最小起订量';
COMMENT ON COLUMN product.moq_unit IS '起订量单位（默认 pcs）';
COMMENT ON COLUMN product.lead_time_days IS '货期（天）';
COMMENT ON COLUMN product.material IS '材质';
COMMENT ON COLUMN product.description IS '产品描述';
COMMENT ON COLUMN product.cost_price IS '采购成本（定价引擎输入；不进 AI prompt 防泄漏，08 §7）';
COMMENT ON COLUMN product.currency IS '成本币种（默认 USD）';
COMMENT ON COLUMN product.suggested_price IS '建议售价（定价引擎参考）';
COMMENT ON COLUMN product.status IS '状态 active / draft / archived';
COMMENT ON COLUMN product.created_by IS '创建人用户 ID';
COMMENT ON COLUMN product.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN product.updated_at IS '更新时间（UTC）';

-- product_spec（无 org_id 列，随 product 归属，RLS 不覆盖）
COMMENT ON COLUMN product_spec.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN product_spec.product_id IS '所属产品 ID';
COMMENT ON COLUMN product_spec.seq IS '规格序号（product 内唯一）';
COMMENT ON COLUMN product_spec.name IS '规格名（如 颜色 / 尺寸）';
COMMENT ON COLUMN product_spec.value IS '规格值';
COMMENT ON COLUMN product_spec.unit IS '单位（可选）';

-- product_price_tier
COMMENT ON COLUMN product_price_tier.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN product_price_tier.product_id IS '所属产品 ID';
COMMENT ON COLUMN product_price_tier.min_qty IS '阶梯最小数量（product 内唯一）';
COMMENT ON COLUMN product_price_tier.unit_price IS '该档单价';

-- product_document
COMMENT ON COLUMN product_document.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN product_document.org_id IS '所属企业';
COMMENT ON COLUMN product_document.product_id IS '所属产品 ID';
COMMENT ON COLUMN product_document.file_name IS '文件名';
COMMENT ON COLUMN product_document.file_url IS '文件存储地址（MinIO 对象 URL）';
COMMENT ON COLUMN product_document.size IS '文件大小（字节）';
COMMENT ON COLUMN product_document.doc_type IS '文档类型 catalog / certification / test_report / other';
COMMENT ON COLUMN product_document.indexed IS '是否已归档入知识库（自动归档 P0 全手动）';
COMMENT ON COLUMN product_document.knowledge_doc_id IS '归档生成的知识文档 ID（自引用 knowledge_document）';
COMMENT ON COLUMN product_document.uploaded_by IS '上传人用户 ID';
COMMENT ON COLUMN product_document.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN product_document.updated_at IS '更新时间（UTC）';

-- product_knowledge
COMMENT ON COLUMN product_knowledge.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN product_knowledge.org_id IS '所属企业';
COMMENT ON COLUMN product_knowledge.product_id IS '所属产品 ID（唯一，一产品一份 AI 沉淀）';
COMMENT ON COLUMN product_knowledge.advantages IS '卖点/优势数组（AI 生成）';
COMMENT ON COLUMN product_knowledge.faqs IS 'FAQ 数组 [{ question, answer }]';
COMMENT ON COLUMN product_knowledge.scenarios IS '适用场景数组';
COMMENT ON COLUMN product_knowledge.sales_scripts IS '销售话术数组';
COMMENT ON COLUMN product_knowledge.status IS '状态 draft（AI 生成）/ confirmed（人工确认）';
COMMENT ON COLUMN product_knowledge.citations IS '生成引用来源（知识文档/分块）';
COMMENT ON COLUMN product_knowledge.task_id IS '生成任务 ID';
COMMENT ON COLUMN product_knowledge.generated_at IS 'AI 生成时间';
COMMENT ON COLUMN product_knowledge.confirmed_by IS '确认人用户 ID';
COMMENT ON COLUMN product_knowledge.confirmed_at IS '确认时间';
COMMENT ON COLUMN product_knowledge.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN product_knowledge.updated_at IS '更新时间（UTC）';

-- knowledge_document
COMMENT ON COLUMN knowledge_document.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN knowledge_document.org_id IS '所属企业';
COMMENT ON COLUMN knowledge_document.file_name IS '文件名';
COMMENT ON COLUMN knowledge_document.category IS '知识分类 product / company / sales / customer / faq / process / other';
COMMENT ON COLUMN knowledge_document.file_type IS '文件类型（pdf / docx / txt 等）';
COMMENT ON COLUMN knowledge_document.size IS '文件大小（字节）';
COMMENT ON COLUMN knowledge_document.file_url IS '文件存储地址（MinIO 对象 URL）';
COMMENT ON COLUMN knowledge_document.status IS '索引状态 indexed / indexing / failed';
COMMENT ON COLUMN knowledge_document.error IS '索引失败原因（status=failed 时）';
COMMENT ON COLUMN knowledge_document.retry_count IS '索引重试次数';
COMMENT ON COLUMN knowledge_document.source IS '来源 upload / email_attachment / product_document';
COMMENT ON COLUMN knowledge_document.product_id IS '关联产品 ID（来源产品资料归档时回填）';
COMMENT ON COLUMN knowledge_document.uploaded_by IS '上传人用户 ID';
COMMENT ON COLUMN knowledge_document.indexed_at IS '索引完成时间';
COMMENT ON COLUMN knowledge_document.deleted_at IS '软删时间（11 §7.2 行保留供引用回溯，chunk 物理清除）';
COMMENT ON COLUMN knowledge_document.deleted_by IS '删除人用户 ID（仅 manager/admin 可删）';
COMMENT ON COLUMN knowledge_document.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN knowledge_document.updated_at IS '更新时间（UTC）';

-- knowledge_chunk
COMMENT ON COLUMN knowledge_chunk.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN knowledge_chunk.org_id IS '所属企业';
COMMENT ON COLUMN knowledge_chunk.document_id IS '所属知识文档 ID';
COMMENT ON COLUMN knowledge_chunk.chunk_index IS '分块序号（document 内唯一，从 0 递增）';
COMMENT ON COLUMN knowledge_chunk.content IS '分块正文';
COMMENT ON COLUMN knowledge_chunk.token_count IS '分块 token 数';
COMMENT ON COLUMN knowledge_chunk.embedding IS '向量嵌入（1536 维，hnsw 索引）';
COMMENT ON COLUMN knowledge_chunk.metadata IS '附加元数据（页码/标题等）';
COMMENT ON COLUMN knowledge_chunk.created_at IS '创建时间（UTC）';

-- ============ ER 07 · 报价与订单 ============

-- quotation
COMMENT ON COLUMN quotation.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN quotation.org_id IS '所属企业';
COMMENT ON COLUMN quotation.quote_no IS '报价单号（org 内唯一，FR-03 编号规则）';
COMMENT ON COLUMN quotation.customer_id IS '报价客户 ID';
COMMENT ON COLUMN quotation.contact_id IS '报价联系人 ID（可空）';
COMMENT ON COLUMN quotation.currency IS '报价币种 ISO 4217';
COMMENT ON COLUMN quotation.incoterms IS '贸易术语（FOB / CIF 等）';
COMMENT ON COLUMN quotation.valid_until IS '报价有效期（截止日期）';
COMMENT ON COLUMN quotation.exchange_rate IS '创建时点汇率快照（MVP 手工维护）';
COMMENT ON COLUMN quotation.exchange_rate_date IS '汇率取值日期';
COMMENT ON COLUMN quotation.exchange_rate_source IS '汇率来源（MVP 固定 manual）';
COMMENT ON COLUMN quotation.payment_terms IS '付款方式（如 T/T 30% 定金）';
COMMENT ON COLUMN quotation.total_amount IS '报价总金额';
COMMENT ON COLUMN quotation.status IS '状态 draft / waiting_approval / sent / won / lost';
COMMENT ON COLUMN quotation.ai_pricing IS 'AI 定价过程数据（核算明细/建议）';
COMMENT ON COLUMN quotation.profit_margin_pct IS '毛利率 %（基于行成本快照追溯）';
COMMENT ON COLUMN quotation.approval_id IS '关联审批单 ID（quote=high 风险必须人工审，FK 由 manual 迁移补齐）';
COMMENT ON COLUMN quotation.owner_id IS '报价负责人用户 ID';
COMMENT ON COLUMN quotation.sent_at IS '发送时间（status=sent 后回填）';
COMMENT ON COLUMN quotation.won_at IS '赢单时间（标记 won；触发客户升级正式 + 活动留痕）';
COMMENT ON COLUMN quotation.lost_reason IS '丢单原因（status=lost 时填写）';
COMMENT ON COLUMN quotation.created_by IS '创建人用户 ID';
COMMENT ON COLUMN quotation.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN quotation.updated_at IS '更新时间（UTC）';

-- quotation_item
COMMENT ON COLUMN quotation_item.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN quotation_item.org_id IS '所属企业';
COMMENT ON COLUMN quotation_item.quotation_id IS '所属报价单 ID';
COMMENT ON COLUMN quotation_item.seq IS '行序号（quotation 内唯一）';
COMMENT ON COLUMN quotation_item.product_id IS '产品 ID';
COMMENT ON COLUMN quotation_item.product_name IS '产品名快照（防产品改名影响历史单据）';
COMMENT ON COLUMN quotation_item.quantity IS '数量';
COMMENT ON COLUMN quotation_item.unit_price IS '单价';
COMMENT ON COLUMN quotation_item.line_total IS '行小计 = quantity × unitPrice';
COMMENT ON COLUMN quotation_item.cost_snapshot IS '五项成本快照 { purchase, freight, insurance, tax, fx }（09 §7）';

-- sales_order
COMMENT ON COLUMN sales_order.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN sales_order.org_id IS '所属企业';
COMMENT ON COLUMN sales_order.order_no IS '订单号（org 内唯一，FR-03 编号规则）';
COMMENT ON COLUMN sales_order.customer_id IS '订单客户 ID';
COMMENT ON COLUMN sales_order.contact_id IS '订单联系人 ID（可空）';
COMMENT ON COLUMN sales_order.quotation_id IS '来源报价单 ID（from-quote 转单时回填，须 won）';
COMMENT ON COLUMN sales_order.delivery_date IS '交期（交付日期，风险监控基准）';
COMMENT ON COLUMN sales_order.payment_terms IS '付款方式';
COMMENT ON COLUMN sales_order.amount IS '订单金额';
COMMENT ON COLUMN sales_order.currency IS '订单币种 ISO 4217';
COMMENT ON COLUMN sales_order.status IS '状态 pending_payment / in_production / ready_to_ship / completed';
COMMENT ON COLUMN sales_order.risk IS '风险标记 normal / at_risk（AI 洞察回写）';
COMMENT ON COLUMN sales_order.progress_po_confirmed IS '进度：PO 已确认（手工勾选）';
COMMENT ON COLUMN sales_order.progress_payment IS '进度：已付款（手工勾选）';
COMMENT ON COLUMN sales_order.production_pct IS '生产进度 0-100（手工录入，唯一数据源）';
COMMENT ON COLUMN sales_order.progress_shipping IS '进度：已发货（手工勾选）';
COMMENT ON COLUMN sales_order.owner_id IS '订单负责人用户 ID';
COMMENT ON COLUMN sales_order.created_by IS '创建人用户 ID';
COMMENT ON COLUMN sales_order.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN sales_order.updated_at IS '更新时间（UTC）';

-- sales_order_item
COMMENT ON COLUMN sales_order_item.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN sales_order_item.org_id IS '所属企业';
COMMENT ON COLUMN sales_order_item.sales_order_id IS '所属订单 ID';
COMMENT ON COLUMN sales_order_item.seq IS '行序号（order 内唯一）';
COMMENT ON COLUMN sales_order_item.product_id IS '产品 ID';
COMMENT ON COLUMN sales_order_item.product_name IS '产品名快照（防产品改名影响历史单据）';
COMMENT ON COLUMN sales_order_item.quantity IS '数量';
COMMENT ON COLUMN sales_order_item.unit_price IS '单价';
COMMENT ON COLUMN sales_order_item.line_total IS '行小计 = quantity × unitPrice';
COMMENT ON COLUMN sales_order_item.cost_snapshot IS '成本快照：转单原样复制报价行；手工建单由定价引擎核算（允许 {}，10 v0.2.1）';

-- order_risk_insight
COMMENT ON COLUMN order_risk_insight.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN order_risk_insight.org_id IS '所属企业';
COMMENT ON COLUMN order_risk_insight.sales_order_id IS '关联订单 ID';
COMMENT ON COLUMN order_risk_insight.delay_days IS '预计延误天数（正数）';
COMMENT ON COLUMN order_risk_insight.reason IS '风险原因摘要';
COMMENT ON COLUMN order_risk_insight.evidence IS '判断证据 jsonb';
COMMENT ON COLUMN order_risk_insight.suggestions IS '处置建议数组 { suggestionId, type, label }';
COMMENT ON COLUMN order_risk_insight.confidence IS '置信度 0-1';
COMMENT ON COLUMN order_risk_insight.status IS '状态 active / resolved / dismissed';
COMMENT ON COLUMN order_risk_insight.generated_at IS 'AI 生成时间';
COMMENT ON COLUMN order_risk_insight.resolved_at IS '风险解除时间';
COMMENT ON COLUMN order_risk_insight.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN order_risk_insight.updated_at IS '更新时间（UTC）';

-- order_progress_log
COMMENT ON COLUMN order_progress_log.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN order_progress_log.org_id IS '所属企业';
COMMENT ON COLUMN order_progress_log.sales_order_id IS '所属订单 ID';
COMMENT ON COLUMN order_progress_log.production_pct IS '录入时的生产进度 0-100（历史轨迹）';
COMMENT ON COLUMN order_progress_log.note IS '备注说明';
COMMENT ON COLUMN order_progress_log.updated_by IS '录入人用户 ID';
COMMENT ON COLUMN order_progress_log.created_at IS '录入时间（UTC）';

-- ============ ER 08 · 审核与数据中心 ============

-- approval_request
COMMENT ON COLUMN approval_request.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN approval_request.org_id IS '所属企业';
COMMENT ON COLUMN approval_request.approval_type IS '审批类型 quote / email_send / contract / order_change / bulk_marketing / customer_delete';
COMMENT ON COLUMN approval_request.risk_level IS '风险级别 high 一律人工审 / medium 可配置自动 / low 不进审批';
COMMENT ON COLUMN approval_request.title IS '审批标题';
COMMENT ON COLUMN approval_request.biz_type IS '业务对象类型（多态引用不建 FK：quotation / message / sales_order 等）';
COMMENT ON COLUMN approval_request.biz_id IS '业务对象 ID（多态引用不建 FK）';
COMMENT ON COLUMN approval_request.context IS '业务上下文快照（审批页展示用）';
COMMENT ON COLUMN approval_request.ai_proposal IS 'AI 方案（待审内容，可被编辑）';
COMMENT ON COLUMN approval_request.confidence IS 'AI 置信度 0-1';
COMMENT ON COLUMN approval_request.reasons IS 'AI 提案理由数组 { text, evidence?, source? }';
COMMENT ON COLUMN approval_request.status IS '状态 pending / auto_approved / approved / edited_approved / rejected / expired（终态）';
COMMENT ON COLUMN approval_request.requested_by_employee_id IS '发起的 AI 员工 ID（系统/用户发起为空）';
COMMENT ON COLUMN approval_request.requested_by_user_id IS '发起的用户 ID（AI 发起为空）';
COMMENT ON COLUMN approval_request.linked_task_id IS '关联 AI 任务 ID（waiting_approval 溯源，v0.1 不建 FK）';
COMMENT ON COLUMN approval_request.expires_at IS '审批超时时间（默认 48h，超时置 expired 终态，Runtime §4.7）';
COMMENT ON COLUMN approval_request.decided_by IS '最终处置人用户 ID';
COMMENT ON COLUMN approval_request.decided_at IS '最终处置时间';
COMMENT ON COLUMN approval_request.result_ref IS '处置结果引用（编辑后内容/落库对象标识）';
COMMENT ON COLUMN approval_request.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN approval_request.updated_at IS '更新时间（UTC）';

-- approval_log
COMMENT ON COLUMN approval_log.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN approval_log.org_id IS '所属企业';
COMMENT ON COLUMN approval_log.approval_id IS '所属审批单 ID';
COMMENT ON COLUMN approval_log.action IS '动作（含 auto_approved / expired 留痕）';
COMMENT ON COLUMN approval_log.approver_id IS '处置人用户 ID';
COMMENT ON COLUMN approval_log.approver_name IS '处置人姓名快照';
COMMENT ON COLUMN approval_log.edited_diff IS '编辑审批时的差异 [{ field, before, after }]';
COMMENT ON COLUMN approval_log.reject_reason IS '拒绝原因（action=rejected 时）';
COMMENT ON COLUMN approval_log.decided_at IS '处置时间';

-- business_report
COMMENT ON COLUMN business_report.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN business_report.org_id IS '所属企业';
COMMENT ON COLUMN business_report.period IS '报告周期 daily / weekly / monthly';
COMMENT ON COLUMN business_report.period_start IS '周期起始日（企业本地日历日）';
COMMENT ON COLUMN business_report.period_end IS '周期结束日（企业本地日历日）';
COMMENT ON COLUMN business_report.status IS '状态 generating / ready / failed';
COMMENT ON COLUMN business_report.content IS '报告正文（五段式：总览/机会/风险/效率/建议）';
COMMENT ON COLUMN business_report.citations IS '引用来源数组';
COMMENT ON COLUMN business_report.task_id IS '生成任务 ID';
COMMENT ON COLUMN business_report.generated_at IS '生成完成时间';
COMMENT ON COLUMN business_report.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN business_report.updated_at IS '更新时间（UTC）';

-- ai_discovery
COMMENT ON COLUMN ai_discovery.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN ai_discovery.org_id IS '所属企业';
COMMENT ON COLUMN ai_discovery.type IS '发现类型 opportunity 机会 / risk 风险';
COMMENT ON COLUMN ai_discovery.title IS '发现标题';
COMMENT ON COLUMN ai_discovery.detail IS '详情描述';
COMMENT ON COLUMN ai_discovery.evidence IS '证据数组 { text, source?, ref? }';
COMMENT ON COLUMN ai_discovery.suggestion IS '建议动作（仅限可撤销的发起类，白名单 13 §7）';
COMMENT ON COLUMN ai_discovery.status IS '状态 new / executed / dismissed';
COMMENT ON COLUMN ai_discovery.executed_ref IS '执行结果引用（生成的任务/策略标识）';
COMMENT ON COLUMN ai_discovery.executed_at IS '执行时间';
COMMENT ON COLUMN ai_discovery.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN ai_discovery.updated_at IS '更新时间（UTC）';

-- analytics_daily_summary
COMMENT ON COLUMN analytics_daily_summary.id IS '雪花 ID（应用层 createId 生成）';
COMMENT ON COLUMN analytics_daily_summary.org_id IS '所属企业';
COMMENT ON COLUMN analytics_daily_summary.stat_date IS '统计日（企业本地日历日）';
COMMENT ON COLUMN analytics_daily_summary.country IS '国家维度（ALL = 全部汇总）';
COMMENT ON COLUMN analytics_daily_summary.employee_id IS '员工维度（ALL = 全员汇总）';
COMMENT ON COLUMN analytics_daily_summary.new_customers IS '新增客户数';
COMMENT ON COLUMN analytics_daily_summary.new_inquiries IS '新增询盘数';
COMMENT ON COLUMN analytics_daily_summary.new_quotes IS '新增报价数';
COMMENT ON COLUMN analytics_daily_summary.found_customers IS 'AI 获客发现数';
COMMENT ON COLUMN analytics_daily_summary.replied_emails IS 'AI 回复邮件数';
COMMENT ON COLUMN analytics_daily_summary.promoted_inquiries IS '询盘升级数（进入跟进）';
COMMENT ON COLUMN analytics_daily_summary.saved_hours IS '节省工时估算';
COMMENT ON COLUMN analytics_daily_summary.created_at IS '创建时间（UTC）';
COMMENT ON COLUMN analytics_daily_summary.updated_at IS '更新时间（UTC）';
