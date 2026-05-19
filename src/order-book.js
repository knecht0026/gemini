/**
 * 限价订单簿撮合引擎
 * 
 * 规则:
 * - side 为 BUY 或 SELL
 * - BUY 可以和 price <= buy price 的 SELL 撮合
 * - SELL 可以和 price >= sell price 的 BUY 撮合
 * - 价格优先，价格相同按 timestamp 先后
 * - 支持部分成交
 * - 完全成交的订单从订单簿移除
 * - cancel 只能取消尚未完全成交的剩余数量
 * - order_id 幂等，重复 submit 不应重复挂单
 */

class Order {
  constructor(orderId, side, price, quantity, timestamp) {
    this.orderId = orderId;
    this.side = side; // 'BUY' or 'SELL'
    this.price = price;
    this.quantity = quantity;
    this.remainingQuantity = quantity;
    this.timestamp = timestamp;
  }
}

class OrderBook {
  constructor() {
    // 买单：按价格降序排列，同价格按时间升序
    // 使用 Map: price -> Array of orders (sorted by timestamp)
    this.bids = new Map(); // price -> [Order, ...]
    
    // 卖单：按价格升序排列，同价格按时间升序
    this.asks = new Map(); // price -> [Order, ...]
    
    // 订单索引：orderId -> Order (用于快速查找和取消)
    this.orderIndex = new Map();
    
    // 已完全成交的订单ID集合（用于幂等性检查）
    this.filledOrderIds = new Set();
  }

  /**
   * 提交订单
   * @param {string} orderId - 订单ID
   * @param {string} side - 'BUY' or 'SELL'
   * @param {number} price - 价格
   * @param {number} quantity - 数量
   * @param {number} timestamp - 时间戳
   * @returns {{trades: Array, bestBid: number|null, bestAsk: number|null}}
   */
  submit(orderId, side, price, quantity, timestamp) {
    const trades = [];

    // 幂等性检查：如果订单已存在（无论是挂单中还是已成交），直接返回
    if (this.orderIndex.has(orderId) || this.filledOrderIds.has(orderId)) {
      return { trades, bestBid: this.getBestBid(), bestAsk: this.getBestAsk() };
    }

    const newOrder = new Order(orderId, side, price, quantity, timestamp);

    // 尝试撮合
    const opposingBook = side === 'BUY' ? this.asks : this.bids;
    const matchingPriceFn = side === 'BUY' 
      ? (askPrice) => askPrice <= price  // BUY: 可以匹配 price <= buy price 的 SELL
      : (bidPrice) => bidPrice >= price; // SELL: 可以匹配 price >= sell price 的 BUY

    while (newOrder.remainingQuantity > 0 && opposingBook.size > 0) {
      // 获取最优价格档
      const bestOpposingPrice = this.getBestOpposingPrice(side);
      
      if (bestOpposingPrice === null || !matchingPriceFn(bestOpposingPrice)) {
        break; // 无法继续撮合
      }

      const opposingOrders = opposingBook.get(bestOpposingPrice);
      
      // 遍历该价格档的所有订单（按时间顺序）
      for (let i = 0; i < opposingOrders.length && newOrder.remainingQuantity > 0; i++) {
        const opposingOrder = opposingOrders[i];
        
        if (opposingOrder.remainingQuantity <= 0) continue;

        const fillQuantity = Math.min(newOrder.remainingQuantity, opposingOrder.remainingQuantity);
        
        // 记录成交
        trades.push({
          buyerOrderId: side === 'BUY' ? newOrder.orderId : opposingOrder.orderId,
          sellerOrderId: side === 'BUY' ? opposingOrder.orderId : newOrder.orderId,
          price: opposingOrder.price, // 以挂单方价格成交
          quantity: fillQuantity,
          timestamp: timestamp
        });

        // 更新剩余数量
        newOrder.remainingQuantity -= fillQuantity;
        opposingOrder.remainingQuantity -= fillQuantity;

        // 如果对手方订单完全成交，从订单簿移除
        if (opposingOrder.remainingQuantity <= 0) {
          this.orderIndex.delete(opposingOrder.orderId);
          this.filledOrderIds.add(opposingOrder.orderId);
        }
      }

      // 清理已完全成交的价格档
      const remainingOrders = opposingOrders.filter(o => o.remainingQuantity > 0);
      if (remainingOrders.length === 0) {
        opposingBook.delete(bestOpposingPrice);
      } else {
        opposingBook.set(bestOpposingPrice, remainingOrders);
      }
    }

    // 如果还有剩余数量，加入订单簿
    if (newOrder.remainingQuantity > 0) {
      this.addToBook(newOrder);
    } else {
      // 完全成交，标记为已填充
      this.filledOrderIds.add(orderId);
    }

    return { trades, bestBid: this.getBestBid(), bestAsk: this.getBestAsk() };
  }

  /**
   * 取消订单
   * @param {string} orderId - 订单ID
   * @returns {{success: boolean, remainingQuantity: number|null}}
   */
  cancel(orderId) {
    const order = this.orderIndex.get(orderId);
    
    if (!order) {
      // 订单不存在或已完全成交
      return { success: false, remainingQuantity: null };
    }

    if (order.remainingQuantity <= 0) {
      // 已经完全成交，不能取消
      return { success: false, remainingQuantity: null };
    }

    const remainingQuantity = order.remainingQuantity;
    
    // 从订单簿中移除
    const book = order.side === 'BUY' ? this.bids : this.asks;
    const ordersAtPrice = book.get(order.price);
    
    if (ordersAtPrice) {
      const filteredOrders = ordersAtPrice.filter(o => o.orderId !== orderId);
      if (filteredOrders.length === 0) {
        book.delete(order.price);
      } else {
        book.set(order.price, filteredOrders);
      }
    }

    this.orderIndex.delete(orderId);

    return { success: true, remainingQuantity };
  }

  /**
   * 查询订单簿深度
   * @param {number} depth - 深度档位
   * @returns {{bids: Array<{price: number, quantity: number}>, asks: Array<{price: number, quantity: number}>}}
   */
  queryBook(depth) {
    const bids = [];
    const asks = [];

    // 获取买单深度（价格从高到低）
    const bidPrices = [...this.bids.keys()].sort((a, b) => b - a);
    for (let i = 0; i < Math.min(depth, bidPrices.length); i++) {
      const price = bidPrices[i];
      const quantity = this.bids.get(price).reduce((sum, o) => sum + o.remainingQuantity, 0);
      bids.push({ price, quantity });
    }

    // 获取卖单深度（价格从低到高）
    const askPrices = [...this.asks.keys()].sort((a, b) => a - b);
    for (let i = 0; i < Math.min(depth, askPrices.length); i++) {
      const price = askPrices[i];
      const quantity = this.asks.get(price).reduce((sum, o) => sum + o.remainingQuantity, 0);
      asks.push({ price, quantity });
    }

    return { bids, asks };
  }

  /**
   * 获取最佳买价
   * @returns {number|null}
   */
  getBestBid() {
    if (this.bids.size === 0) return null;
    return Math.max(...this.bids.keys());
  }

  /**
   * 获取最佳卖价
   * @returns {number|null}
   */
  getBestAsk() {
    if (this.asks.size === 0) return null;
    return Math.min(...this.asks.keys());
  }

  /**
   * 获取最优对手方价格
   * @param {string} side - 'BUY' or 'SELL'
   * @returns {number|null}
   */
  getBestOpposingPrice(side) {
    if (side === 'BUY') {
      // 买单的对手方是卖单，取最低卖价
      return this.getBestAsk();
    } else {
      // 卖单的对手方是买单，取最高买价
      return this.getBestBid();
    }
  }

  /**
   * 将订单添加到订单簿
   * @param {Order} order
   */
  addToBook(order) {
    const book = order.side === 'BUY' ? this.bids : this.asks;
    
    if (!book.has(order.price)) {
      book.set(order.price, []);
    }
    
    const ordersAtPrice = book.get(order.price);
    ordersAtPrice.push(order);
    
    // 按时间戳排序（虽然通常是按顺序添加，但为了安全起见）
    ordersAtPrice.sort((a, b) => a.timestamp - b.timestamp);
    
    this.orderIndex.set(order.orderId, order);
  }

  /**
   * 获取订单状态
   * @param {string} orderId
   * @returns {{exists: boolean, remainingQuantity: number|null, isFilled: boolean}}
   */
  getOrderStatus(orderId) {
    if (this.filledOrderIds.has(orderId)) {
      return { exists: true, remainingQuantity: 0, isFilled: true };
    }
    
    const order = this.orderIndex.get(orderId);
    if (order) {
      return { 
        exists: true, 
        remainingQuantity: order.remainingQuantity, 
        isFilled: order.remainingQuantity <= 0 
      };
    }
    
    return { exists: false, remainingQuantity: null, isFilled: false };
  }
}

module.exports = { OrderBook, Order };
