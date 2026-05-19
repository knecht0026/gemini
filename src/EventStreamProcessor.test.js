/**
 * EventStreamProcessor 测试文件
 * 
 * 测试覆盖:
 * 1. 基本 purchase 处理
 * 2. 乱序事件处理
 * 3. watermark 语义
 * 4. exactly-once / event_id 幂等性
 * 5. refund 先于 purchase 到达
 * 6. refund 不能超过可退款余额
 * 7. top-K 动态维护
 * 8. 输出不可回滚
 */

const { EventStreamProcessor } = require('./EventStreamProcessor');

// 辅助函数：生成时间戳
function makeTimestamp(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).getTime();
}

describe('EventStreamProcessor', () => {
  let processor;

  beforeEach(() => {
    processor = new EventStreamProcessor();
  });

  describe('基本功能', () => {
    test('处理单个 purchase 事件', () => {
      const event = {
        type: 'purchase',
        event_id: 'p1',
        user_id: 'u1',
        amount: 100,
        event_time: makeTimestamp(2024, 1, 1, 10, 0, 0)
      };

      processor.processEvent(event);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01']).toBeDefined();
      expect(stats['2024-01-01'].net_revenue).toBe(100);
      expect(stats['2024-01-01'].unique_buyers).toBe(1);
      expect(stats['2024-01-01'].top_3_users).toEqual([{ user_id: 'u1', amount: 100 }]);
      expect(stats['2024-01-01'].finalized).toBe(false);
    });

    test('处理多个 purchase 事件同一天', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) },
        { type: 'purchase', event_id: 'p3', user_id: 'u1', amount: 50, event_time: makeTimestamp(2024, 1, 1, 12, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(350);
      expect(stats['2024-01-01'].unique_buyers).toBe(2);
      // u1: 150, u2: 200 -> top: u2, u1
      expect(stats['2024-01-01'].top_3_users).toEqual([
        { user_id: 'u2', amount: 200 },
        { user_id: 'u1', amount: 150 }
      ]);
    });

    test('处理多天的 purchase 事件', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 2, 11, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(100);
      expect(stats['2024-01-01'].unique_buyers).toBe(1);
      expect(stats['2024-01-02'].net_revenue).toBe(200);
      expect(stats['2024-01-02'].unique_buyers).toBe(1);
    });
  });

  describe('幂等性 (exactly-once)', () => {
    test('相同 event_id 的 purchase 只能处理一次', () => {
      const event = {
        type: 'purchase',
        event_id: 'p1',
        user_id: 'u1',
        amount: 100,
        event_time: makeTimestamp(2024, 1, 1, 10, 0, 0)
      };

      processor.processEvent(event);
      processor.processEvent(event); // 重复处理
      processor.processEvent(event); // 再次重复

      const stats = processor.getCurrentStats();
      expect(stats['2024-01-01'].net_revenue).toBe(100); // 只计算一次
      expect(stats['2024-01-01'].unique_buyers).toBe(1);
    });

    test('相同 event_id 的 refund 只能处理一次', () => {
      const purchase = {
        type: 'purchase',
        event_id: 'p1',
        user_id: 'u1',
        amount: 100,
        event_time: makeTimestamp(2024, 1, 1, 10, 0, 0)
      };

      const refund = {
        type: 'refund',
        event_id: 'r1',
        original_event_id: 'p1',
        amount: 30,
        event_time: makeTimestamp(2024, 1, 1, 11, 0, 0)
      };

      processor.processEvent(purchase);
      processor.processEvent(refund);
      processor.processEvent(refund); // 重复处理

      const stats = processor.getCurrentStats();
      expect(stats['2024-01-01'].net_revenue).toBe(70); // 只退款一次
    });
  });

  describe('Watermark 语义', () => {
    test('watermark 触发已确定日期的输出', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 2, 0, 0, 0) } // 1月1日结束
      ];

      const outputs = processor.processEvents(events);

      expect(outputs.length).toBe(1);
      expect(outputs[0].watermark).toBe(makeTimestamp(2024, 1, 2, 0, 0, 0));
      expect(outputs[0].results['2024-01-01']).toBeDefined();
      expect(outputs[0].results['2024-01-01'].net_revenue).toBe(100);
    });

    test('watermark 不会输出未确定的日期', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 1, 12, 0, 0) } // 1月1日还未结束
      ];

      const outputs = processor.processEvents(events);

      expect(outputs.length).toBe(0); // 没有输出
      const stats = processor.getCurrentStats();
      expect(stats['2024-01-01'].finalized).toBe(false);
    });

    test('watermark 递增', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 2, 0, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 2, 10, 0, 0) },
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 3, 0, 0, 0) }
      ];

      const outputs = processor.processEvents(events);

      expect(outputs.length).toBe(2);
      expect(outputs[0].results['2024-01-01'].net_revenue).toBe(100);
      expect(outputs[1].results['2024-01-02'].net_revenue).toBe(200);
    });
  });

  describe('Refund 处理', () => {
    test('refund 在 purchase 之后到达', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 30, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(70);
      expect(stats['2024-01-01'].unique_buyers).toBe(1);
      expect(stats['2024-01-01'].top_3_users).toEqual([{ user_id: 'u1', amount: 70 }]);
    });

    test('refund 先于 purchase 到达（暂存）', () => {
      const events = [
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 30, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) },
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(70);
      expect(stats['2024-01-01'].unique_buyers).toBe(1);
    });

    test('refund 不能超过可退款余额', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 60, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) },
        { type: 'refund', event_id: 'r2', original_event_id: 'p1', amount: 60, event_time: makeTimestamp(2024, 1, 1, 12, 0, 0) } // 超过余额
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      // 100 - 60 = 40 (第一次退 60), 第二次只能退 40，所以 net_revenue = 0
      expect(stats['2024-01-01'].net_revenue).toBe(0); // 100 - 60 - 40 = 0
      expect(stats['2024-01-01'].unique_buyers).toBe(0);
      expect(stats['2024-01-01'].top_3_users).toEqual([]);
    });

    test('多个 refund 累计不超过 purchase 金额', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 30, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) },
        { type: 'refund', event_id: 'r2', original_event_id: 'p1', amount: 40, event_time: makeTimestamp(2024, 1, 1, 12, 0, 0) },
        { type: 'refund', event_id: 'r3', original_event_id: 'p1', amount: 50, event_time: makeTimestamp(2024, 1, 1, 13, 0, 0) } // 只能退 30
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      // 100 - 30 - 40 - 30 = 0
      expect(stats['2024-01-01'].net_revenue).toBe(0);
      // 用户金额为 0，应该被移除
      expect(stats['2024-01-01'].unique_buyers).toBe(0);
      expect(stats['2024-01-01'].top_3_users).toEqual([]);
    });
  });

  describe('乱序事件', () => {
    test('乱序的 purchase 事件', () => {
      const events = [
        { type: 'purchase', event_id: 'p3', user_id: 'u3', amount: 300, event_time: makeTimestamp(2024, 1, 1, 12, 0, 0) },
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(600);
      expect(stats['2024-01-01'].unique_buyers).toBe(3);
      expect(stats['2024-01-01'].top_3_users).toEqual([
        { user_id: 'u3', amount: 300 },
        { user_id: 'u2', amount: 200 },
        { user_id: 'u1', amount: 100 }
      ]);
    });

    test('乱序的 refund 和 purchase', () => {
      const events = [
        { type: 'refund', event_id: 'r2', original_event_id: 'p2', amount: 20, event_time: makeTimestamp(2024, 1, 1, 11, 30, 0) },
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 30, event_time: makeTimestamp(2024, 1, 1, 10, 30, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(250); // 100 - 30 + 200 - 20 = 250
      expect(stats['2024-01-01'].unique_buyers).toBe(2);
      expect(stats['2024-01-01'].top_3_users).toEqual([
        { user_id: 'u2', amount: 180 },
        { user_id: 'u1', amount: 70 }
      ]);
    });
  });

  describe('Top-K 动态维护', () => {
    test('正确计算前 3 个用户', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p3', user_id: 'u3', amount: 300, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p4', user_id: 'u4', amount: 400, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p5', user_id: 'u5', amount: 500, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].top_3_users).toEqual([
        { user_id: 'u5', amount: 500 },
        { user_id: 'u4', amount: 400 },
        { user_id: 'u3', amount: 300 }
      ]);
    });

    test('用户多次购买累计金额', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 150, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p3', user_id: 'u1', amount: 200, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) },
        { type: 'purchase', event_id: 'p4', user_id: 'u3', amount: 250, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      // u1: 300, u2: 150, u3: 250
      expect(stats['2024-01-01'].top_3_users).toEqual([
        { user_id: 'u1', amount: 300 },
        { user_id: 'u3', amount: 250 },
        { user_id: 'u2', amount: 150 }
      ]);
    });
  });

  describe('输出不可回滚', () => {
    test('watermark 输出后不能被修改', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 2, 0, 0, 0) },
        // 尝试添加新的事件影响已输出的日期
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      const outputs = processor.processEvents(events);

      // 第一次 watermark 输出
      expect(outputs[0].results['2024-01-01'].net_revenue).toBe(100);

      // 后续添加的 purchase 不应该影响已输出的结果
      const finalOutputs = processor.getOutputResults();
      expect(finalOutputs[0].results.get('2024-01-01').net_revenue).toBe(100);

      // 当前统计中，2024-01-01 已经 finalized，不应再变化
      const stats = processor.getCurrentStats();
      expect(stats['2024-01-01'].finalized).toBe(true);
      expect(stats['2024-01-01'].net_revenue).toBe(100); // 保持不变
    });

    test('watermark 输出后 refund 不能修改已输出的结果', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 2, 0, 0, 0) },
        // 尝试添加 refund 影响已输出的日期
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 30, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      const outputs = processor.processEvents(events);

      expect(outputs[0].results['2024-01-01'].net_revenue).toBe(100);

      // refund 不应该影响已输出的结果
      const stats = processor.getCurrentStats();
      expect(stats['2024-01-01'].finalized).toBe(true);
      expect(stats['2024-01-01'].net_revenue).toBe(100); // 保持不变
    });

    test('late 的 purchase 和 refund 都不影响已 finalize 的日期', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 2, 0, 0, 0) },
        // 迟到的事件
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 30, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      processor.processEvents(events);

      const outputs = processor.getOutputResults();
      expect(outputs[0].results.get('2024-01-01').net_revenue).toBe(100);
      expect(outputs[0].results.get('2024-01-01').unique_buyers).toBe(1);
    });
  });

  describe('综合场景测试', () => {
    test('完整的乱序事件流处理', () => {
      // 模拟一个复杂的乱序事件流
      const events = [
        // 第 2 天的事件先到
        { type: 'purchase', event_id: 'p3', user_id: 'u1', amount: 300, event_time: makeTimestamp(2024, 1, 2, 10, 0, 0) },
        
        // 第 1 天的事件
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 20, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) },
        
        // refund 先到
        { type: 'refund', event_id: 'r2', original_event_id: 'p2', amount: 30, event_time: makeTimestamp(2024, 1, 1, 12, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 11, 30, 0) },
        
        // watermark 触发第 1 天输出
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 2, 0, 0, 0) },
        
        // 迟到的第 1 天事件（不应该影响输出）
        { type: 'purchase', event_id: 'p4', user_id: 'u3', amount: 500, event_time: makeTimestamp(2024, 1, 1, 9, 0, 0) },
        
        // 第 2 天的更多事件
        { type: 'purchase', event_id: 'p5', user_id: 'u2', amount: 150, event_time: makeTimestamp(2024, 1, 2, 11, 0, 0) },
        
        // watermark 触发第 2 天输出
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 3, 0, 0, 0) }
      ];

      const outputs = processor.processEvents(events);

      // 验证输出
      expect(outputs.length).toBe(2);

      // 第 1 天输出
      // p1: 100 - 20 = 80 (u1)
      // p2: 200 - 30 = 170 (u2)
      // total: 250
      expect(outputs[0].results['2024-01-01'].net_revenue).toBe(250);
      expect(outputs[0].results['2024-01-01'].unique_buyers).toBe(2);
      expect(outputs[0].results['2024-01-01'].top_3_users).toEqual([
        { user_id: 'u2', amount: 170 },
        { user_id: 'u1', amount: 80 }
      ]);

      // 第 2 天输出
      // p3: 300 (u1)
      // p5: 150 (u2)
      // total: 450
      expect(outputs[1].results['2024-01-02'].net_revenue).toBe(450);
      expect(outputs[1].results['2024-01-02'].unique_buyers).toBe(2);
      expect(outputs[1].results['2024-01-02'].top_3_users).toEqual([
        { user_id: 'u1', amount: 300 },
        { user_id: 'u2', amount: 150 }
      ]);

      // 验证迟到的事件不影响已输出的结果
      const stats = processor.getCurrentStats();
      expect(stats['2024-01-01'].finalized).toBe(true);
      expect(stats['2024-01-01'].net_revenue).toBe(250); // 保持输出时的值
    });
  });

  describe('边界情况', () => {
    test('空事件列表', () => {
      const outputs = processor.processEvents([]);
      expect(outputs.length).toBe(0);
      expect(processor.getCurrentStats()).toEqual({});
    });

    test('只有 watermark 没有事件', () => {
      const events = [
        { type: 'watermark', timestamp: makeTimestamp(2024, 1, 2, 0, 0, 0) }
      ];

      const outputs = processor.processEvents(events);
      expect(outputs.length).toBe(0);
    });

    test('refund 金额为 0', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 0, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(100);
    });

    test('refund 金额大于 purchase 金额', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 50, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].net_revenue).toBe(0);
      expect(stats['2024-01-01'].unique_buyers).toBe(0);
    });

    test('用户数量为 0 时 top_3_users 为空', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'refund', event_id: 'r1', original_event_id: 'p1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 11, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].unique_buyers).toBe(0);
      expect(stats['2024-01-01'].top_3_users).toEqual([]);
    });

    test('少于 3 个用户时的 top_K', () => {
      const events = [
        { type: 'purchase', event_id: 'p1', user_id: 'u1', amount: 100, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) },
        { type: 'purchase', event_id: 'p2', user_id: 'u2', amount: 200, event_time: makeTimestamp(2024, 1, 1, 10, 0, 0) }
      ];

      processor.processEvents(events);
      const stats = processor.getCurrentStats();

      expect(stats['2024-01-01'].top_3_users).toEqual([
        { user_id: 'u2', amount: 200 },
        { user_id: 'u1', amount: 100 }
      ]);
    });
  });
});
