/**
 * 基于 createMcpHandler 的无状态 MCP HTTP handler 工厂
 *
 * 使用 @modelcontextprotocol/server 的 createMcpHandler（v2 协议 2026-07-28）
 * 构造一个 Web-standard fetch handler，按 groupId 绑定：
 *
 * - 工厂闭包从 groupServices 缓存中取（或惰性创建）GroupMcpService，
 *   返回其已注册好工具的 McpServer 实例。
 * - 入站激进升级：legacy: 'reject' 拒绝所有 2025-era（无 envelope）请求，
 *   仅服务 2026-07-28 modern 流量。
 * - handler.fetch 是 Web-standard face，Hono 端用 c.req.raw 桥接
 *   （预解析 body 经 parsedBody 传入，避免重复读取请求流）。
 *
 * createMcpHandler 的 factory 每个请求都会被调用一次（modern 路径是 per-request
 * serving），与 groupServices 缓存互补：缓存复用 GroupMcpService/McpServer
 * 实例以避免重复初始化与工具注册。
 */
import { createMcpHandler } from '@modelcontextprotocol/server';

import { MrtrRelayService } from '../../services/mrtr-relay-service.js';
import { getCoreServiceManager } from '../../services/service-registry.js';
import { getAllConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { GroupMcpService } from './group-service.js';

import type { McpHttpHandler } from '@modelcontextprotocol/server';

// ─────────────────────────────────────────────────────────────────────────────
// P5 MRTR：Hub 级 requestState codec 单例。
//
// 必须是进程级单例（所有 group 共用同一个 codec/key），否则不同 group 的 GroupMcpService
// 各持不同 key mint 的 state，客户端在 group 间（或同一 group 缓存失效重建后）回传的 state
// 会 verify 失败。factory 模块级构造一次，注入每个 GroupMcpService 构造，不随 group 缓存
// 失效而重建。
//
// key/ttl 来源（Task 10 接通 system.json）：
//   - ttlSeconds: systemConfig.mrtr.stateTtlSeconds（默认 600）
//   - key 优先级: systemConfig.mrtr.stateKey（hex，≥32 字节解码后）
//                 → 环境变量 MRTR_REQUEST_STATE_KEY（hex）
//                 → 启动时随机生成 32 字节
// 因 getAllConfig 是异步的，relay 改为惰性单例：首次 ensureGroupMcpService 时构造，
// 之后复用。随机 key 意味着进程重启后旧 state 全部失效（可接受：TTL 本就 600s）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 MRTR requestState 的 HMAC key（32 字节）。
 *
 * 来源优先级：
 *   1. 参数 `configuredKey`（来自 system.json 的 mrtr.stateKey，hex 编码，须解码后 ≥32 字节）
 *   2. 环境变量 `MRTR_REQUEST_STATE_KEY`（hex 编码，须解码后 ≥32 字节）
 *   3. 否则随机生成 32 字节
 *
 * 随机 key 意味着进程重启后旧 state 全部失效（可接受：TTL 本就 600s）。
 */
function resolveMrtrKey(configuredKey?: string): Uint8Array {
  // 候选 key 来源按优先级收集，逐个尝试
  const candidates = [configuredKey, process.env['MRTR_REQUEST_STATE_KEY']].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  for (const candidate of candidates) {
    // hex 解码；非法或过短时记录并尝试下一个候选（fail-open，不阻断启动）
    try {
      const bytes = Buffer.from(candidate, 'hex');
      if (bytes.byteLength >= 32) {
        return new Uint8Array(bytes);
      }
      logger.warn('MRTR stateKey 解码后不足 32 字节，回退下一候选/随机生成', {
        source:
          candidate === configuredKey ? 'system.json mrtr.stateKey' : 'MRTR_REQUEST_STATE_KEY',
        byteLength: bytes.byteLength,
      });
    } catch (error) {
      logger.warn('MRTR stateKey hex 解码失败，回退下一候选/随机生成', {
        source:
          candidate === configuredKey ? 'system.json mrtr.stateKey' : 'MRTR_REQUEST_STATE_KEY',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

/**
 * 进程级 MRTR relay 单例（惰性构造）。
 * 首次 getMrtrRelay() 时从 system.json 读取 mrtr.stateTtlSeconds / mrtr.stateKey 构造，
 * 之后所有 GroupMcpService 共享同一实例。构造失败（不应发生）时回退到 schema 默认值。
 *
 * P5 修复（代码审查 C1）：mrtr.enabled=false 时返回 null（不构造 relay）。
 * GroupMcpService 已正确处理 mrtrRelay 为 undefined 的情况——buildMcpServer 不注入
 * requestState.verify，handler 对 input_required 走「识别但不中转」路径（直传上游
 * InputRequiredResult，Task 7 已实现）。
 *
 * 注意：enabled 决策与 relay 实例一样是进程级单例——首次读取的决策缓存到
 * mrtrRelayPromise（resolved 值为 null 时后续调用复用同一 null），避免每次请求重读
 * config。运行期翻转 enabled 需重启进程（与 relay 单例 key 缓存语义一致）。
 */
let mrtrRelayInstance: MrtrRelayService | null = null;
let mrtrRelayPromise: Promise<MrtrRelayService | null> | null = null;

/**
 * 获取（必要时惰性构造）MRTR relay 单例。
 * mrtr.enabled=false（或配置读取失败按默认 true 回退后 relay 构造失败）时返回 null。
 * 并发首次调用共享同一个 Promise，避免重复构造。
 */
async function getMrtrRelay(): Promise<MrtrRelayService | null> {
  if (mrtrRelayInstance) {
    return mrtrRelayInstance;
  }
  if (!mrtrRelayPromise) {
    mrtrRelayPromise = (async () => {
      // 从 system.json 读 mrtr 配置；缺失时 getAllConfig 不抛错（返回默认空对象）
      let enabled = true;
      let ttlSeconds = 600;
      let stateKey: string | undefined;
      // P5 修复（I4）：配置读取失败时不能把「用错误默认值构造的 relay」缓存进单例，
      // 否则后续永远用错误默认值（多实例下会与其他实例 state 互相 verify 失败）。
      // 故 configReadFailed 标记瞬时错误；失败时本次调用回退默认值构造一份「用完即弃」
      // 的 relay 供当前请求，但不写入 mrtrRelayInstance/mrtrRelayPromise——清掉 promise
      // 让下次调用重新读 config 重试。仅成功读 config 且构造成功才缓存。
      let configReadFailed = false;
      try {
        const cfg = await getAllConfig();
        // mrtr 整块可选；提供时 schema 已保证 enabled/stateTtlSeconds 有默认值
        enabled = cfg.system?.mrtr?.enabled ?? true;
        ttlSeconds = cfg.system?.mrtr?.stateTtlSeconds ?? 600;
        stateKey = cfg.system?.mrtr?.stateKey;
      } catch (error) {
        configReadFailed = true;
        logger.warn(
          '读取 mrtr 配置失败，本次回退默认值（enabled=true, ttl=600s, 随机 key）且不缓存单例，下次调用重试',
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      // P5 修复（C1）：mrtr.enabled=false 不构造 relay，返回 null。
      // GroupMcpService 收到 undefined 的 mrtrRelay 后走「识别但不中转」保底路径。
      // 注意：enabled=false 是稳定的配置决策（非瞬时错误），正常缓存 null。
      // 但若 enabled 的判定本身依赖一次失败的 config 读取，则不缓存（下次重读 config
      // 才能拿到真实 enabled 值）。
      if (!enabled) {
        if (configReadFailed) {
          // 罕见：config 读失败恰好 fallback 到 enabled=true 之外的路径不会到这里；
          // 防御性：只要 config 读取本身失败，就不缓存任何决策。
          mrtrRelayPromise = null;
          return null;
        }
        logger.info('mrtr.enabled=false，MRTR 中转关闭（P5）—— handler 仅识别 input_required');
        return null;
      }
      const relay = new MrtrRelayService({
        key: resolveMrtrKey(stateKey),
        ttlSeconds,
      });
      // 仅成功读 config（无瞬时错误）才缓存单例。configReadFailed=true 时构造本身
      // 不会失败（createRequestStateCodec 用随机 key + 默认 ttl 必然成功），但本次
      // 用的默认值可能是错的——故返回这份「用完即弃」的 relay 供当前请求，清掉
      // promise 让下次调用重读 config 重试。
      if (configReadFailed) {
        mrtrRelayPromise = null;
        logger.warn('MRTR relay 本次以默认值构造（未缓存），下次调用将重读 config（I4）');
        return relay;
      }
      mrtrRelayInstance = relay;
      logger.info('MRTR relay 单例已构造（P5）', {
        ttlSeconds,
        hasStateKey: stateKey !== undefined,
      });
      return relay;
    })();
  }
  return mrtrRelayPromise;
}

// groupServices 缓存与 group-router 共享（同一模块内单例），统一关闭。
const groupServices: Map<string, GroupMcpService> = new Map();
// 按 groupId 缓存的 McpHttpHandler：handler 设计为构造一次复用
// （其 fetch 每请求内部 per-request serving），避免每请求重建 handler 与 bus。
const groupHandlers: Map<string, McpHttpHandler> = new Map();
// in-flight Promise 缓存：防止并发请求对同一 group 重复初始化。
// 当请求 A 正在创建 service/handler 时，请求 B 会拿到同一个 Promise 等待，
// 而不是各自走 check-then-act 创建第二个实例。
const serviceInflight: Map<string, Promise<GroupMcpService>> = new Map();
const handlerInflight: Map<string, Promise<McpHttpHandler>> = new Map();

/**
 * 暴露 groupServices 缓存，供 group-router 复用与统一关闭。
 */
export function getGroupServicesCache(): Map<string, GroupMcpService> {
  return groupServices;
}

/**
 * 暴露 groupHandlers 缓存，供 group-router 在关闭时统一 close()。
 */
export function getGroupHandlersCache(): Map<string, McpHttpHandler> {
  return groupHandlers;
}

/**
 * 确保指定组的 GroupMcpService 已创建并初始化，放入缓存后返回。
 *
 * 保留原 group-router 的缓存语义：按 groupId 惰性创建、复用、统一关闭。
 */
export async function ensureGroupMcpService(groupId: string): Promise<GroupMcpService> {
  const existing = groupServices.get(groupId);
  if (existing) {
    return existing;
  }

  // 命中正在进行的初始化则等待同一个 Promise，避免并发重复创建
  const inflight = serviceInflight.get(groupId);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    logger.info('为组创建MCP服务实例', { groupId });
    const coreServiceManager = await getCoreServiceManager();
    // P5 MRTR：注入 relay 单例，使 handler 既能 mint Hub state（input_required），
    // 又能让 SDK 在 McpServer 构造时挂上 requestState.verify 钩子（验签客户端回传的 state）。
    // mrtr.enabled=false 时 getMrtrRelay 返回 null——GroupMcpService 收到 undefined 的
    // mrtrRelay 后不注入 verify，handler 走「识别但不中转」保底路径（P5 修复 C1）。
    const mrtrRelay = (await getMrtrRelay()) ?? undefined;
    const groupService = new GroupMcpService(groupId, coreServiceManager, mrtrRelay);
    await groupService.initialize();

    groupServices.set(groupId, groupService);
    return groupService;
  })();

  serviceInflight.set(groupId, promise);
  try {
    return await promise;
  } finally {
    serviceInflight.delete(groupId);
  }
}

/**
 * 按 groupId 创建一个绑定到该组的 MCP HTTP handler。
 *
 * 返回的 handler.fetch 接受标准 Request（Hono 的 c.req.raw），并支持通过
 * options.parsedBody 传入预解析的 JSON body（避免重复读取请求流）。
 *
 * 注意：此 handler 不再做组存在性校验——校验由上层 group-router 的
 * groupValidationMiddleware 负责，调用方需在通过校验后再构造 handler。
 */
export async function createGroupMcpHandler(groupId: string): Promise<McpHttpHandler> {
  // 命中缓存则直接复用，避免每请求重建 handler/bus
  const cached = groupHandlers.get(groupId);
  if (cached) {
    return cached;
  }

  // 命中正在进行的创建则等待，避免并发重复构造 handler
  const inflight = handlerInflight.get(groupId);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    // 确保 service 已初始化并放入缓存（factory 闭包从缓存中取）
    await ensureGroupMcpService(groupId);

    const handler = createMcpHandler(
      // McpServerFactory：按请求返回该组对应的 McpServer
      //
      // NOTE（代码审查 I1，偏离 SDK 契约）：
      // SDK 文档要求 factory 每次返回 fresh McpServer 实例（modern 路径下 SDK 会
      // 对返回的 server 做 installModernOnlyHandlers / setNegotiatedProtocolVersion
      // / seedClientIdentityFromEnvelope 等有状态操作）。当前实现复用同一
      // GroupMcpService 的 McpServer——这在当前 beta 版本能工作（上述操作在同版本
      // 下幂等，handler 不读 clientInfo），但偏离了契约。
      // Follow-up：把 GroupMcpService 的工具注册逻辑抽成 buildServer(groupId)，
      // factory 每次返回新实例。代价可接受（getAllTools 是内存读，不连外部 server）。
      // 待 SDK GA 后重新评估，见总体 spec P1 follow-up。
      () => {
        const groupService = groupServices.get(groupId);
        if (!groupService) {
          // 不应发生：上面 ensureGroupMcpService 已放入缓存。
          // 极端情况下（创建与失效并发），抛错由上层 catch 返回 500。
          throw new Error(`组 '${groupId}' 的 MCP 服务未初始化`);
        }
        // 复用缓存中已注册工具的 McpServer 实例
        return groupService.getMcpServer();
      },
      {
        // 入站激进升级：拒绝 2025-era（legacy）流量，仅服务 2026-07-28
        legacy: 'reject',
        onerror: (error) => {
          logger.error('组MCP handler 错误', error, { groupId });
        },
      },
    );

    groupHandlers.set(groupId, handler);
    return handler;
  })();

  handlerInflight.set(groupId, promise);
  try {
    return await promise;
  } finally {
    handlerInflight.delete(groupId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 缓存失效钩子
//
// 配置变更（组 servers/tools、服务器列表、API 工具）后调用，使下次请求惰性重建
// GroupMcpService + handler，避免客户端看到过期工具列表。
//
// 失效会优雅释放旧实例：
//   - handler.close()  —— 中止在飞的 modern exchanges / 关闭 bus
//   - service.shutdown() —— 调 mcpServer.close() 释放旧 server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 失效指定组的 service + handler 缓存（先优雅关闭再删除）。
 *
 * 用于"已知受影响 group"的精确失效（如 PUT/DELETE 单个组、配置工具过滤）。
 * 失效后下次请求会通过 ensureGroupMcpService + createGroupMcpHandler 惰性重建。
 *
 * 不存在的 group 不会报错（幂等）。
 */
export async function invalidateGroupMcpService(groupId: string): Promise<void> {
  // 清除 in-flight 标记，让失效后的下次请求能重新初始化
  serviceInflight.delete(groupId);
  handlerInflight.delete(groupId);

  const handler = groupHandlers.get(groupId);
  if (handler) {
    try {
      await handler.close();
    } catch (error) {
      logger.error('关闭组MCP handler 失败（失效流程）', error as Error, { groupId });
    }
    groupHandlers.delete(groupId);
  }

  const service = groupServices.get(groupId);
  if (service) {
    try {
      await service.shutdown();
    } catch (error) {
      logger.error('关闭组MCP service 失败（失效流程）', error as Error, { groupId });
    }
    groupServices.delete(groupId);
  }
}

/**
 * 失效所有 group 的 service + handler 缓存（先优雅关闭再删除）。
 *
 * 用于"无法精确判断受影响 group"的场景（如全局 coreServiceManager 重建，
 * 因为所有 GroupMcpService 都持有旧的 coreServiceManager 引用，必须全部重建）。
 */
export async function invalidateAllGroupMcpServices(): Promise<void> {
  // 清除所有 in-flight 标记
  serviceInflight.clear();
  handlerInflight.clear();

  // 先关闭所有 handler
  const handlerEntries = Array.from(groupHandlers.entries());
  await Promise.allSettled(
    handlerEntries.map(async ([groupId, handler]) => {
      try {
        await handler.close();
      } catch (error) {
        logger.error('关闭组MCP handler 失败（失效全部）', error as Error, { groupId });
      }
    }),
  );
  groupHandlers.clear();

  // 再关闭所有 service
  const serviceEntries = Array.from(groupServices.entries());
  await Promise.allSettled(
    serviceEntries.map(async ([groupId, service]) => {
      try {
        await service.shutdown();
      } catch (error) {
        logger.error('关闭组MCP service 失败（失效全部）', error as Error, { groupId });
      }
    }),
  );
  groupServices.clear();

  logger.info('所有组MCP缓存已失效', {
    handlerCount: handlerEntries.length,
    serviceCount: serviceEntries.length,
  });
}
