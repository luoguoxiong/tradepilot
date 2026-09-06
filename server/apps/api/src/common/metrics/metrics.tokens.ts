/**
 * 指标模块 DI token（独立文件避免 controller ↔ module 循环导入的 TDZ 问题）。
 */
export const PROM_REGISTRY = Symbol('PROM_REGISTRY');
