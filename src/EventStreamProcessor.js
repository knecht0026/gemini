/**
 * EventStreamProcessor - 乱序事件流聚合引擎
 * 
 * 数据结构说明:
 * 
 * 1. seenEventIds: Set<string>
 *    - 用于幂等性检查，记录所有已处理过的 event_id
 * 
 * 2. pendingRefunds: Map<string, Array<RefundEvent>>
 *    - key: original_event_id
 *    - value: 等待对应 purchase 到达的 refund 事件列表
 *    - 用于处理 refund 先于 purchase 到达的情况
 * 
 * 3. purchases: Map<string, PurchaseEvent>
 *    - key: event_id
 *    - value: purchase 事件对象
 *    - 存储所有已到达的 purchase 事件
 * 
 * 4. refunds: Map<string, RefundEvent[]>
 *    - key: original_event_id (purchase 的 event_id)
 *    - value: 该 purchase 对应的所有 refund 列表
 *    - 用于计算可退款余额
 * 
 * 5. dailyStats: Map<string, DailyStat>
 *    - key: 日期字符串 (YYYY-MM-DD)
 *    - value: DailyStat 对象，包含:
 *      - netRevenue: number (净收入)
 *      - buyers: Map<user_id, number> (用户及其购买金额)
 *      - finalized: boolean (是否已输出，不可再修改)
 * 
 * 6. userDailyAmounts: Map<date, Map<user_id, number>>
 *    - 嵌套 Map，用于快速查询某日某用户的总金额
 *    - 外层 key: 日期
 *    - 内层 key: user_id, value: 金额总和
 * 
 * 7. watermarkValue: number | null
 *    - 当前最大的 watermark 时间戳
 * 
 * 8. outputResults: Array<{watermark: number, results: Map<string, DailyStat>}>
 *    - 存储每个 watermark 输出的结果（不可回滚）
 */

class EventStreamProcessor {
  constructor() {
    // 幂等性：记录已处理的 event_id
    this.seenEventIds = new Set();
    
    // 暂存未到 purchase 的 refund
    this.pendingRefunds = new Map(); // Map<original_event_id, RefundEvent[]>
    
    // 存储 purchase 事件
    this.purchases = new Map(); // Map<event_id, PurchaseEvent>
    
    // 存储 refund 事件（按 original_event_id 分组）
    this.refunds = new Map(); // Map<original_event_id, RefundEvent[]>
    
    // 每日统计
    this.dailyStats = new Map(); // Map<date_str, DailyStat>
    
    // 当前 watermark
    this.watermarkValue = null;
    
    // 已输出的结果（不可回滚）
    this.outputResults = [];
  }

  /**
   * 获取日期字符串 (YYYY-MM-DD)
   */
  _getDateFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toISOString().split('T')[0];
  }

  /**
   * 处理单个事件
   */
  processEvent(event) {
    if (event.type === 'watermark') {
      return this._processWatermark(event);
    } else if (event.type === 'purchase') {
      return this._processPurchase(event);
    } else if (event.type === 'refund') {
      return this._processRefund(event);
    }
    return null;
  }

  /**
   * 处理 purchase 事件
   */
  _processPurchase(event) {
    const { event_id, user_id, amount, event_time } = event;
    
    // 幂等性检查
    if (this.seenEventIds.has(event_id)) {
      return null;
    }
    this.seenEventIds.add(event_id);
    
    // 如果 event_time 已超过当前 watermark，则不能影响已输出的统计
    if (this.watermarkValue !== null && event_time <= this.watermarkValue) {
      // 检查该日期是否已 finalize
      const dateStr = this._getDateFromTimestamp(event_time);
      const dailyStat = this.dailyStats.get(dateStr);
      if (dailyStat && dailyStat.finalized) {
        // 已输出的日期不能再修改
        return null;
      }
    }
    
    // 存储 purchase
    this.purchases.set(event_id, event);
    
    // 初始化 refunds 列表
    if (!this.refunds.has(event_id)) {
      this.refunds.set(event_id, []);
    }
    
    // 更新统计
    this._updateStatsForPurchase(event);
    
    // 处理可能存在的 pending refunds
    this._processPendingRefunds(event_id);
    
    return null;
  }

  /**
   * 处理 refund 事件
   */
  _processRefund(event) {
    const { event_id, original_event_id, amount, event_time } = event;
    
    // 幂等性检查
    if (this.seenEventIds.has(event_id)) {
      return null;
    }
    this.seenEventIds.add(event_id);
    
    // 检查对应的 purchase 是否存在
    const purchase = this.purchases.get(original_event_id);
    
    if (!purchase) {
      // purchase 未到，暂存
      if (!this.pendingRefunds.has(original_event_id)) {
        this.pendingRefunds.set(original_event_id, []);
      }
      this.pendingRefunds.get(original_event_id).push(event);
      return null;
    }
    
    // purchase 已存在，处理 refund
    this._applyRefund(event, purchase);
    
    return null;
  }

  /**
   * 应用 refund 到 purchase
   */
  _applyRefund(refundEvent, purchase) {
    const { event_id: refundId, original_event_id, amount: refundAmount, event_time } = refundEvent;
    
    // 检查该日期是否已 finalize
    const dateStr = this._getDateFromTimestamp(purchase.event_time);
    const dailyStat = this.dailyStats.get(dateStr);
    if (dailyStat && dailyStat.finalized) {
      // 已输出的日期不能再修改
      return;
    }
    
    // 计算已退款总额
    const existingRefunds = this.refunds.get(original_event_id) || [];
    const totalRefunded = existingRefunds.reduce((sum, r) => sum + r.amount, 0);
    const availableBalance = purchase.amount - totalRefunded;
    
    // 实际可退款金额（不能超过可退款余额）
    const actualRefundAmount = Math.min(refundAmount, Math.max(0, availableBalance));
    
    // 存储 refund
    if (!this.refunds.has(original_event_id)) {
      this.refunds.set(original_event_id, []);
    }
    this.refunds.get(original_event_id).push({ ...refundEvent, actualAmount: actualRefundAmount });
    
    // 如果有实际退款发生，更新统计
    if (actualRefundAmount > 0) {
      this._updateStatsForRefund(purchase, actualRefundAmount);
    }
  }

  /**
   * 处理 pending refunds
   */
  _processPendingRefunds(purchaseEventId) {
    const pending = this.pendingRefunds.get(purchaseEventId);
    if (!pending) return;
    
    const purchase = this.purchases.get(purchaseEventId);
    for (const refundEvent of pending) {
      this._applyRefund(refundEvent, purchase);
    }
    
    this.pendingRefunds.delete(purchaseEventId);
  }

  /**
   * 更新 purchase 相关的统计
   */
  _updateStatsForPurchase(event) {
    const { user_id, amount, event_time } = event;
    const dateStr = this._getDateFromTimestamp(event_time);
    
    if (!this.dailyStats.has(dateStr)) {
      this.dailyStats.set(dateStr, {
        netRevenue: 0,
        buyers: new Map(), // user_id -> total_amount
        finalized: false
      });
    }
    
    const stat = this.dailyStats.get(dateStr);
    stat.netRevenue += amount;
    
    // 更新用户金额
    const currentAmount = stat.buyers.get(user_id) || 0;
    stat.buyers.set(user_id, currentAmount + amount);
  }

  /**
   * 更新 refund 相关的统计
   */
  _updateStatsForRefund(purchase, refundAmount) {
    const { user_id, event_time } = purchase;
    const dateStr = this._getDateFromTimestamp(event_time);
    
    const stat = this.dailyStats.get(dateStr);
    if (!stat) return;
    
    stat.netRevenue -= refundAmount;
    
    // 更新用户金额
    const currentAmount = stat.buyers.get(user_id) || 0;
    const newAmount = Math.max(0, currentAmount - refundAmount);
    if (newAmount === 0) {
      stat.buyers.delete(user_id);
    } else {
      stat.buyers.set(user_id, newAmount);
    }
  }

  /**
   * 处理 watermark 事件
   */
  _processWatermark(event) {
    const { timestamp } = event;
    
    // 更新 watermark
    const previousWatermark = this.watermarkValue;
    this.watermarkValue = Math.max(this.watermarkValue || 0, timestamp);
    
    // 收集需要输出的日期（event_time <= watermark 且未 finalize 的日期）
    const datesToFinalize = [];
    for (const [dateStr, stat] of this.dailyStats.entries()) {
      if (!stat.finalized) {
        // 检查该日期的所有事件是否都已确定
        // 即：该日期 <= watermark
        const dateTimestamp = new Date(dateStr + 'T00:00:00Z').getTime();
        // 更精确的检查：该日期的结束时间 <= watermark
        const dateEndTimestamp = dateTimestamp + 24 * 60 * 60 * 1000;
        if (dateEndTimestamp <= timestamp) {
          datesToFinalize.push(dateStr);
        }
      }
    }
    
    // 对日期排序
    datesToFinalize.sort();
    
    // 构建输出结果
    const results = new Map();
    for (const dateStr of datesToFinalize) {
      const stat = this.dailyStats.get(dateStr);
      stat.finalized = true;
      
      // 计算 top 3 用户
      const top3Users = this._getTop3Users(stat.buyers);
      
      results.set(dateStr, {
        net_revenue: stat.netRevenue,
        unique_buyers: stat.buyers.size,
        top_3_users: top3Users
      });
    }
    
    if (results.size > 0) {
      this.outputResults.push({
        watermark: timestamp,
        results: results
      });
      return { type: 'watermark_output', watermark: timestamp, results: Object.fromEntries(results) };
    }
    
    return null;
  }

  /**
   * 获取金额最高的前 3 个用户
   */
  _getTop3Users(buyersMap) {
    const entries = Array.from(buyersMap.entries());
    entries.sort((a, b) => b[1] - a[1]); // 按金额降序
    return entries.slice(0, 3).map(([user_id, amount]) => ({ user_id, amount }));
  }

  /**
   * 批量处理事件
   */
  processEvents(events) {
    const outputs = [];
    for (const event of events) {
      const output = this.processEvent(event);
      if (output) {
        outputs.push(output);
      }
    }
    return outputs;
  }

  /**
   * 获取所有已输出的结果
   */
  getOutputResults() {
    return this.outputResults;
  }

  /**
   * 获取当前统计状态（用于测试）
   */
  getCurrentStats() {
    const result = {};
    for (const [dateStr, stat] of this.dailyStats.entries()) {
      const top3Users = this._getTop3Users(stat.buyers);
      result[dateStr] = {
        net_revenue: stat.netRevenue,
        unique_buyers: stat.buyers.size,
        top_3_users: top3Users,
        finalized: stat.finalized
      };
    }
    return result;
  }
}

module.exports = { EventStreamProcessor };
