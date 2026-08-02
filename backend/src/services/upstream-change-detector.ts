// backend/src/services/upstream-change-detector.ts
import type { Logger } from '../utils/logger.js';

export interface UpstreamChangeDetectorOptions {
  onChange: (serverId: string) => void;
  pollIntervalMs: number;
  pollBackoffMs: number;
  logger?: Logger;
}

/**
 * 工具集签名：排序后 join，仅基于 name 集合。
 * 描述等非结构性变化不触发变更。
 */
function computeSignature(tools: { name: string }[]): string {
  return tools
    .map((t) => t.name)
    .toSorted()
    .join('|');
}

/**
 * 上游工具集变更检测：双路（listChanged 实时 + 轮询兜底）。
 *
 * 采用 baseline（基准）与 current（最新）双 Map 模式：
 * - `baseline` 在首次 saveSnapshot 时建立，detectChanges 命中后推进到 current。
 * - `snapshots` 始终保存最新签名，作为「当前」值参与比对。
 * 这样保证连续多次 saveSnapshot 后 detectChanges 比对的是「上次变更基准 vs 当前」，
 * 既不会重复触发，也能识别真正的结构性变化。
 */
export class UpstreamChangeDetector {
  private readonly opts: UpstreamChangeDetectorOptions;
  private readonly snapshots = new Map<string, string>(); // serverId → current signature
  private readonly baseline = new Map<string, string>(); // serverId → baseline signature
  private readonly lastPushedAt = new Map<string, number>(); // serverId → 最近主动推送时间
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private getToolsFn: ((serverId: string) => Promise<{ name: string }[]>) | null = null;

  constructor(opts: UpstreamChangeDetectorOptions) {
    this.opts = opts;
  }

  /**
   * 保存工具集快照（discoverServerTools / 比对后更新）。
   * 首次调用同时建立 baseline；后续调用仅更新 current。
   */
  saveSnapshot(serverId: string, tools: { name: string }[]): void {
    const sig = computeSignature(tools);
    if (!this.baseline.has(serverId)) {
      this.baseline.set(serverId, sig);
    }
    this.snapshots.set(serverId, sig);
  }

  /**
   * 检测指定 server 的工具集是否变化（对比 baseline 与 current）。
   * 命中后推进 baseline 到 current，避免重复触发。
   */
  detectChanges(serverId: string): void {
    const base = this.baseline.get(serverId);
    const cur = this.snapshots.get(serverId);
    if (base !== undefined && cur !== undefined && base !== cur) {
      this.baseline.set(serverId, cur); // 推进基准
      this.opts.onChange(serverId);
    }
  }

  /** 收到上游 listChanged 通知时调用，记录推送时间并 emit 实时变更事件 */
  onUpstreamNotification(serverId: string): void {
    this.lastPushedAt.set(serverId, Date.now());
    // 实时路径：交由外部重新拉取并 saveSnapshot + detectChanges
    this.opts.onChange(serverId);
  }

  /** 启动周期轮询兜底 */
  startPolling(
    getTools: (serverId: string) => Promise<{ name: string }[]>,
    serverIds: string[],
  ): Promise<void> {
    this.getToolsFn = getTools;
    this.pollTimer = setInterval(() => void this.pollOnce(serverIds), this.opts.pollIntervalMs);
    return Promise.resolve();
  }

  private async pollOnce(serverIds: string[]): Promise<void> {
    for (const serverId of serverIds) {
      try {
        // 智能跳过：近期主动推送过的 server 降频
        const lastPush = this.lastPushedAt.get(serverId);
        if (lastPush && Date.now() - lastPush < this.opts.pollBackoffMs) {
          continue;
        }
        if (!this.getToolsFn) continue;
        const tools = await this.getToolsFn(serverId);
        const sig = computeSignature(tools);
        const prev = this.snapshots.get(serverId);
        this.snapshots.set(serverId, sig);
        // 首次无 baseline 时不触发；仅当与已记录签名不同时触发
        if (prev !== undefined && prev !== sig) {
          this.baseline.set(serverId, sig); // 同步推进基准，避免轮询与实时路径重复触发
          this.opts.onChange(serverId);
        }
      } catch (err) {
        this.opts.logger?.warn('上游工具轮询失败', { serverId, error: String(err) });
      }
    }
  }

  /** 停止轮询（shutdown/test cleanup 用） */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
