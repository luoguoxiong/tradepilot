/**
 * 02 AI 数字员工中心接口（接口 02 §2/§3，M5-C3）：
 * - GET /ai-employees：员工卡片列表（02 §3.1，全量 6 卡）
 * - GET /ai-employees/roles：角色模板清单（创建向导预填，02 §2）
 * - POST /ai-employees：创建 AI 员工（仅 admin/manager，02 §3.2）
 * - GET /ai-employees/{id}/tasks：该员工任务列表（02 §3.3，复用 14）
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { paginationQuerySchema } from '@tradepilot/shared';
import { resolveScope, type OrgScopeContext } from '@tradepilot/db';
import { EmployeesService } from './employees.service.js';
import { createEmployeeSchema, type CreateEmployeeDto } from './employees.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../auth/token.service.js';

@Controller('ai-employees')
export class EmployeesController {
  constructor(@Inject(EmployeesService) private readonly employees: EmployeesService) {}

  /** 02 §3.1 员工卡片列表（全量；MVP 无分页语义，分页参数仅兼容统一契约） */
  @Get()
  async list(
    @Query(new ZodValidationPipe(paginationQuerySchema))
    query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.employees.list(this.ctx(req), query.page, query.pageSize);
  }

  /** 02 §2 角色模板清单（创建向导预填） */
  @Get('roles')
  async roles(@Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.employees.roles(this.ctx(req));
  }

  /** 02 §3.2 创建 AI 员工（仅 admin/manager；sales 越权 40301 在服务层校验） */
  @Post()
  async create(
    @Body(new ZodValidationPipe(createEmployeeSchema)) dto: CreateEmployeeDto,
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.employees.create(this.ctx(req), dto);
  }

  /** 02 §3.3 该员工任务列表（复用 tasks 列表按 employeeId 过滤） */
  @Get(':id/tasks')
  async listTasks(
    @Param('id') employeeId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema))
    query: { page: number; pageSize: number },
    @Req() req: Request & { authUser?: AccessTokenPayload },
  ) {
    return this.employees.listTasks(this.ctx(req), employeeId, query.page, query.pageSize);
  }

  /** 02 §2/§3.4 暂停员工全部执行中任务（仅 admin/manager；sales 越权在服务层校验） */
  @Post(':id/pause')
  async pause(@Param('id') employeeId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.employees.pause(this.ctx(req), employeeId);
  }

  /** 02 §2/§3.4 恢复员工（名下 paused 任务重新排队续跑） */
  @Post(':id/resume')
  async resume(@Param('id') employeeId: string, @Req() req: Request & { authUser?: AccessTokenPayload }) {
    return this.employees.resume(this.ctx(req), employeeId);
  }

  /** 资源级访问取角色上限（本模块为 org 级资源，scope 恒 all；保留统一 ctx 形态） */
  private ctx(
    req: Request & { authUser?: AccessTokenPayload },
    scope?: 'self' | 'team' | 'all',
  ): OrgScopeContext {
    const user = this.requireUser(req);
    return {
      orgId: user.orgId,
      userId: user.sub,
      role: user.role,
      scope: resolveScope(user.role, scope),
    };
  }

  private requireUser(req: Request & { authUser?: AccessTokenPayload }): AccessTokenPayload {
    const user = req.authUser;
    if (!user) {
      throw new Error('未认证（JwtAuthGuard 缺失）');
    }
    return user;
  }
}
