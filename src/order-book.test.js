/**
 * 限价订单簿撮合引擎测试
 */

const { OrderBook } = require('./order-book');

describe('OrderBook', () => {
  let orderBook;

  beforeEach(() => {
    orderBook = new OrderBook();
  });

  describe('submit - Basic Functionality', () => {
    test('should submit a BUY order and add to book', () => {
      const result = orderBook.submit('order1', 'BUY', 100, 10, 1000);
      
      expect(result.trades).toEqual([]);
      expect(result.bestBid).toBe(100);
      expect(result.bestAsk).toBe(null);
      
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([{ price: 100, quantity: 10 }]);
      expect(book.asks).toEqual([]);
    });

    test('should submit a SELL order and add to book', () => {
      const result = orderBook.submit('order1', 'SELL', 100, 10, 1000);
      
      expect(result.trades).toEqual([]);
      expect(result.bestBid).toBe(null);
      expect(result.bestAsk).toBe(100);
      
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([]);
      expect(book.asks).toEqual([{ price: 100, quantity: 10 }]);
    });
  });

  describe('submit - Matching Rules', () => {
    test('BUY should match with SELL where ask price <= buy price', () => {
      // 先挂一个卖单，价格 95
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      
      // 提交买单，价格 100 (可以匹配 price <= 100 的卖单)
      const result = orderBook.submit('buy1', 'BUY', 100, 5, 2000);
      
      expect(result.trades.length).toBe(1);
      expect(result.trades[0]).toEqual({
        buyerOrderId: 'buy1',
        sellerOrderId: 'sell1',
        price: 95, // 以挂单方（卖方）价格成交
        quantity: 5,
        timestamp: 2000
      });
      expect(result.bestBid).toBe(null); // 买单完全成交
      expect(result.bestAsk).toBe(95); // 卖单部分成交后还有剩余
      
      // 卖单还剩 5
      const book = orderBook.queryBook(5);
      expect(book.asks).toEqual([{ price: 95, quantity: 5 }]);
    });

    test('SELL should match with BUY where bid price >= sell price', () => {
      // 先挂一个买单，价格 105
      orderBook.submit('buy1', 'BUY', 105, 10, 1000);
      
      // 提交卖单，价格 100 (可以匹配 price >= 100 的买单)
      const result = orderBook.submit('sell1', 'SELL', 100, 5, 2000);
      
      expect(result.trades.length).toBe(1);
      expect(result.trades[0]).toEqual({
        buyerOrderId: 'buy1',
        sellerOrderId: 'sell1',
        price: 105, // 以挂单方（买方）价格成交
        quantity: 5,
        timestamp: 2000
      });
      
      // 买单还剩 5
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([{ price: 105, quantity: 5 }]);
    });

    test('should not match if prices do not cross', () => {
      // 卖单价格 100
      orderBook.submit('sell1', 'SELL', 100, 10, 1000);
      
      // 买单价格 90 (不能匹配 price <= 90 的卖单，因为卖单是 100)
      const result = orderBook.submit('buy1', 'BUY', 90, 5, 2000);
      
      expect(result.trades).toEqual([]);
      expect(result.bestBid).toBe(90);
      expect(result.bestAsk).toBe(100);
    });
  });

  describe('submit - Price and Time Priority', () => {
    test('should match by price priority (better price first)', () => {
      // 挂两个卖单，不同价格
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      orderBook.submit('sell2', 'SELL', 90, 10, 1001);
      
      // 提交买单，价格 100
      const result = orderBook.submit('buy1', 'BUY', 100, 15, 2000);
      
      // 应该先匹配价格更低的卖单 (90)
      expect(result.trades.length).toBe(2);
      expect(result.trades[0].price).toBe(90); // 先匹配 90
      expect(result.trades[0].quantity).toBe(10);
      expect(result.trades[1].price).toBe(95); // 再匹配 95
      expect(result.trades[1].quantity).toBe(5);
    });

    test('should match by time priority at same price', () => {
      // 挂两个卖单，相同价格，不同时间
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      orderBook.submit('sell2', 'SELL', 95, 10, 1001);
      
      // 提交买单，价格 100
      const result = orderBook.submit('buy1', 'BUY', 100, 15, 2000);
      
      // 应该先匹配时间更早的卖单
      expect(result.trades.length).toBe(2);
      expect(result.trades[0].sellerOrderId).toBe('sell1');
      expect(result.trades[0].quantity).toBe(10);
      expect(result.trades[1].sellerOrderId).toBe('sell2');
      expect(result.trades[1].quantity).toBe(5);
    });
  });

  describe('submit - Partial Fill', () => {
    test('should support partial fill and keep remaining in book', () => {
      // 挂一个卖单，数量 10
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      
      // 提交买单，数量 5 (部分成交)
      const result = orderBook.submit('buy1', 'BUY', 100, 5, 2000);
      
      expect(result.trades.length).toBe(1);
      expect(result.trades[0].quantity).toBe(5);
      
      // 买单完全成交，卖单还剩 5
      expect(result.bestBid).toBe(null);
      expect(result.bestAsk).toBe(95);
      
      const book = orderBook.queryBook(5);
      expect(book.asks).toEqual([{ price: 95, quantity: 5 }]);
    });

    test('should remove fully filled order from book', () => {
      // 挂一个卖单，数量 10
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      
      // 提交买单，数量 10 (完全成交)
      const result = orderBook.submit('buy1', 'BUY', 100, 10, 2000);
      
      expect(result.trades.length).toBe(1);
      expect(result.trades[0].quantity).toBe(10);
      
      // 两个订单都完全成交，从订单簿移除
      expect(result.bestBid).toBe(null);
      expect(result.bestAsk).toBe(null);
      
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([]);
      expect(book.asks).toEqual([]);
    });
  });

  describe('submit - Idempotency', () => {
    test('should not duplicate order on repeated submit', () => {
      orderBook.submit('order1', 'BUY', 100, 10, 1000);
      
      // 重复提交同一订单
      const result = orderBook.submit('order1', 'BUY', 100, 10, 2000);
      
      expect(result.trades).toEqual([]);
      
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([{ price: 100, quantity: 10 }]); // 只有一个订单
    });

    test('should not re-add fully filled order on repeated submit', () => {
      // 挂卖单
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      
      // 买单完全成交
      orderBook.submit('buy1', 'BUY', 100, 10, 2000);
      
      // 重复提交已完全成交的买单
      const result = orderBook.submit('buy1', 'BUY', 100, 10, 3000);
      
      expect(result.trades).toEqual([]);
      
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([]); // 不应该重新加入订单簿
      expect(book.asks).toEqual([]); // 卖单也完全成交了
    });
  });

  describe('cancel', () => {
    test('should cancel an existing order', () => {
      orderBook.submit('order1', 'BUY', 100, 10, 1000);
      
      const result = orderBook.cancel('order1');
      
      expect(result.success).toBe(true);
      expect(result.remainingQuantity).toBe(10);
      
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([]);
    });

    test('should cancel partially filled order', () => {
      // 挂卖单，数量 10
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      
      // 买单部分成交，数量 5
      orderBook.submit('buy1', 'BUY', 100, 5, 2000);
      
      // 卖单还剩 5，取消它
      const result = orderBook.cancel('sell1');
      
      expect(result.success).toBe(true);
      expect(result.remainingQuantity).toBe(5);
      
      const book = orderBook.queryBook(5);
      expect(book.asks).toEqual([]);
    });

    test('should fail to cancel non-existent order', () => {
      const result = orderBook.cancel('nonexistent');
      
      expect(result.success).toBe(false);
      expect(result.remainingQuantity).toBe(null);
    });

    test('should fail to cancel fully filled order', () => {
      // 挂卖单
      orderBook.submit('sell1', 'SELL', 95, 10, 1000);
      
      // 买单完全成交
      orderBook.submit('buy1', 'BUY', 100, 10, 2000);
      
      // 尝试取消已完全成交的订单
      const result = orderBook.cancel('buy1');
      
      expect(result.success).toBe(false);
      expect(result.remainingQuantity).toBe(null);
    });
  });

  describe('queryBook', () => {
    test('should return correct depth for bids', () => {
      orderBook.submit('buy1', 'BUY', 100, 10, 1000);
      orderBook.submit('buy2', 'BUY', 99, 20, 1001);
      orderBook.submit('buy3', 'BUY', 98, 30, 1002);
      
      const result = orderBook.queryBook(2);
      
      expect(result.bids.length).toBe(2);
      expect(result.bids[0]).toEqual({ price: 100, quantity: 10 });
      expect(result.bids[1]).toEqual({ price: 99, quantity: 20 });
    });

    test('should return correct depth for asks', () => {
      orderBook.submit('sell1', 'SELL', 100, 10, 1000);
      orderBook.submit('sell2', 'SELL', 101, 20, 1001);
      orderBook.submit('sell3', 'SELL', 102, 30, 1002);
      
      const result = orderBook.queryBook(2);
      
      expect(result.asks.length).toBe(2);
      expect(result.asks[0]).toEqual({ price: 100, quantity: 10 });
      expect(result.asks[1]).toEqual({ price: 101, quantity: 20 });
    });

    test('should aggregate quantities at same price', () => {
      orderBook.submit('buy1', 'BUY', 100, 10, 1000);
      orderBook.submit('buy2', 'BUY', 100, 20, 1001);
      orderBook.submit('buy3', 'BUY', 100, 30, 1002);
      
      const result = orderBook.queryBook(5);
      
      expect(result.bids).toEqual([{ price: 100, quantity: 60 }]);
    });

    test('should handle depth larger than available levels', () => {
      orderBook.submit('buy1', 'BUY', 100, 10, 1000);
      orderBook.submit('sell1', 'SELL', 105, 20, 1001);
      
      const result = orderBook.queryBook(10);
      
      expect(result.bids.length).toBe(1);
      expect(result.asks.length).toBe(1);
    });
  });

  describe('Complex Scenarios', () => {
    test('should handle multiple matches across price levels', () => {
      // 挂多个卖单
      orderBook.submit('sell1', 'SELL', 90, 5, 1000);
      orderBook.submit('sell2', 'SELL', 92, 10, 1001);
      orderBook.submit('sell3', 'SELL', 95, 15, 1002);
      
      // 提交大买单
      const result = orderBook.submit('buy1', 'BUY', 95, 25, 2000);
      
      expect(result.trades.length).toBe(3);
      expect(result.trades[0]).toEqual({
        buyerOrderId: 'buy1',
        sellerOrderId: 'sell1',
        price: 90,
        quantity: 5,
        timestamp: 2000
      });
      expect(result.trades[1]).toEqual({
        buyerOrderId: 'buy1',
        sellerOrderId: 'sell2',
        price: 92,
        quantity: 10,
        timestamp: 2000
      });
      expect(result.trades[2]).toEqual({
        buyerOrderId: 'buy1',
        sellerOrderId: 'sell3',
        price: 95,
        quantity: 10,
        timestamp: 2000
      });
      
      // sell3 还剩 5
      const book = orderBook.queryBook(5);
      expect(book.asks).toEqual([{ price: 95, quantity: 5 }]);
      expect(book.bids).toEqual([]);
    });

    test('should handle interleaved buy and sell orders', () => {
      // 交替提交买卖单
      orderBook.submit('buy1', 'BUY', 100, 10, 1000);
      orderBook.submit('sell1', 'SELL', 105, 10, 1001);
      orderBook.submit('buy2', 'BUY', 99, 10, 1002);
      orderBook.submit('sell2', 'SELL', 104, 10, 1003);
      
      const book = orderBook.queryBook(5);
      
      // 买单：100, 99
      expect(book.bids.length).toBe(2);
      expect(book.bids[0].price).toBe(100);
      expect(book.bids[1].price).toBe(99);
      
      // 卖单：104, 105
      expect(book.asks.length).toBe(2);
      expect(book.asks[0].price).toBe(104);
      expect(book.asks[1].price).toBe(105);
    });

    test('should handle exact quantity match', () => {
      orderBook.submit('sell1', 'SELL', 100, 10, 1000);
      
      const result = orderBook.submit('buy1', 'BUY', 100, 10, 2000);
      
      expect(result.trades.length).toBe(1);
      expect(result.trades[0].quantity).toBe(10);
      
      const book = orderBook.queryBook(5);
      expect(book.bids).toEqual([]);
      expect(book.asks).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    test('should handle zero quantity order', () => {
      const result = orderBook.submit('order1', 'BUY', 100, 0, 1000);
      
      // 零数量订单应该直接完全成交（或不被接受）
      expect(result.trades).toEqual([]);
      // 根据实现，零数量订单会立即被标记为完全成交
    });

    test('should handle very large quantity', () => {
      orderBook.submit('sell1', 'SELL', 100, 1000000, 1000);
      
      const result = orderBook.submit('buy1', 'BUY', 100, 500000, 2000);
      
      expect(result.trades.length).toBe(1);
      expect(result.trades[0].quantity).toBe(500000);
      
      const book = orderBook.queryBook(5);
      expect(book.asks).toEqual([{ price: 100, quantity: 500000 }]);
    });

    test('should handle same price buy and sell at same time', () => {
      orderBook.submit('buy1', 'BUY', 100, 10, 1000);
      
      const result = orderBook.submit('sell1', 'SELL', 100, 5, 1000);
      
      expect(result.trades.length).toBe(1);
      expect(result.trades[0].price).toBe(100);
      expect(result.trades[0].quantity).toBe(5);
    });
  });
});

// 复杂度说明
/*
 * 时间复杂度分析:
 * 
 * submit(orderId, side, price, quantity, timestamp):
 * - 幂等性检查: O(1) - Map/Set 查找
 * - 撮合循环: 最坏情况 O(P * N) 其中 P 是价格档数量，N 是每个价格档的平均订单数
 *   - 实际上通常远小于这个值，因为订单只会匹配到能成交的价格档
 * - 添加到订单簿: O(1) 平均 (Map 操作)
 * - 总体: O(P * N) 最坏情况，O(1) 最好情况（无撮合）
 * 
 * cancel(orderId):
 * - 查找订单: O(1) - Map 查找
 * - 从价格档移除: O(N) - 需要遍历该价格档的订单数组
 * - 总体: O(N) 其中 N 是该价格档的订单数量
 * 
 * queryBook(depth):
 * - 获取价格键并排序: O(P log P) 其中 P 是价格档数量
 * - 聚合数量: O(depth * N) 其中 N 是每个价格档的平均订单数
 * - 总体: O(P log P + depth * N)
 * 
 * getBestBid/getBestAsk:
 * - 遍历所有价格键找最大/最小值: O(P)
 * - 可以使用有序数据结构优化到 O(1) 或 O(log P)
 * 
 * 空间复杂度:
 * - O(Total Orders) - 存储所有未完全成交的订单
 * 
 * 优化建议:
 * 1. 使用平衡二叉搜索树或跳表来维护价格档，可以将 getBestBid/getBestAsk 优化到 O(1) 或 O(log P)
 * 2. 使用链表代替数组来存储同价格的订单，可以将 cancel 操作优化到 O(1)（如果有双向链表和节点引用）
 * 3. 使用两个堆（最大堆存买单，最小堆存卖单）来快速获取最优价格
 */
