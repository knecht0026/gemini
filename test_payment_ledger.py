"""
Payment Ledger 单元测试

测试覆盖：
1. top_up - 充值功能
2. authorize - 授权和冻结
3. capture - 捕获金额
4. void - 撤销授权
5. refund - 退款
6. 命令去重
7. 过期处理
8. 边界情况和错误处理
"""

import unittest
from payment_ledger import PaymentLedger, AuthStatus, CaptureStatus


class TestTopUp(unittest.TestCase):
    """测试充值功能"""
    
    def setUp(self):
        self.ledger = PaymentLedger()
    
    def test_top_up_new_account(self):
        """给新账户充值"""
        result = self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        self.assertEqual(state["accounts"]["user1"]["balance"], 10000)
        self.assertEqual(state["accounts"]["user1"]["frozen"], 0)
    
    def test_top_up_existing_account(self):
        """给已有账户充值"""
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 5000
        })
        
        result = self.ledger.process_command({
            "command_id": "cmd2",
            "type": "top_up",
            "account": "user1",
            "amount": 3000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        self.assertEqual(state["accounts"]["user1"]["balance"], 8000)
    
    def test_top_up_duplicate_command(self):
        """重复的命令ID应该失败"""
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 5000
        })
        
        result = self.ledger.process_command({
            "command_id": "cmd1",  # 相同的 command_id
            "type": "top_up",
            "account": "user1",
            "amount": 3000
        })
        
        self.assertFalse(result.success)
        self.assertIn("Duplicate", result.message)
        
        # 余额不应该改变
        state = self.ledger.get_ledger_state()
        self.assertEqual(state["accounts"]["user1"]["balance"], 5000)
    
    def test_top_up_invalid_amount(self):
        """无效金额应该失败"""
        result = self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": -100
        })
        
        self.assertFalse(result.success)
        self.assertIn("positive", result.message)
    
    def test_top_up_zero_amount(self):
        """零金额应该失败"""
        result = self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 0
        })
        
        self.assertFalse(result.success)


class TestAuthorize(unittest.TestCase):
    """测试授权功能"""
    
    def setUp(self):
        self.ledger = PaymentLedger(current_time=1000)
    
    def test_authorize_success(self):
        """成功授权"""
        # 先充值
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        
        # 授权
        result = self.ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 2000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        # 检查账户状态
        self.assertEqual(state["accounts"]["user1"]["balance"], 10000)
        self.assertEqual(state["accounts"]["user1"]["frozen"], 5000)
        self.assertEqual(state["accounts"]["user1"]["available"], 5000)
        
        # 检查授权状态
        auth = state["authorizations"]["auth1"]
        self.assertEqual(auth["status"], "pending")
        self.assertEqual(auth["amount"], 5000)
        self.assertEqual(auth["remaining_amount"], 5000)
    
    def test_authorize_insufficient_balance(self):
        """余额不足时授权应该失败"""
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 3000
        })
        
        result = self.ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 2000
        })
        
        self.assertFalse(result.success)
        self.assertIn("Insufficient", result.message)
        
        # 账户状态不应改变
        state = self.ledger.get_ledger_state()
        self.assertEqual(state["accounts"]["user1"]["frozen"], 0)
    
    def test_authorize_duplicate_auth_id(self):
        """重复的 auth_id 应该失败"""
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        
        self.ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 2000
        })
        
        result = self.ledger.process_command({
            "command_id": "cmd3",
            "type": "authorize",
            "auth_id": "auth1",  # 相同的 auth_id
            "account": "user1",
            "amount": 3000,
            "expires_at": 2000
        })
        
        self.assertFalse(result.success)
        self.assertIn("already exists", result.message)
    
    def test_authorize_exceeds_available_balance(self):
        """授权金额超过可用余额（考虑已冻结部分）"""
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        
        # 第一次授权
        self.ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 7000,
            "expires_at": 2000
        })
        
        # 第二次授权，可用余额只有 3000
        result = self.ledger.process_command({
            "command_id": "cmd3",
            "type": "authorize",
            "auth_id": "auth2",
            "account": "user1",
            "amount": 5000,
            "expires_at": 2000
        })
        
        self.assertFalse(result.success)


class TestCapture(unittest.TestCase):
    """测试捕获功能"""
    
    def setUp(self):
        self.ledger = PaymentLedger(current_time=1000)
        # 设置初始状态
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        self.ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 2000
        })
    
    def test_capture_success(self):
        """成功捕获"""
        result = self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 3000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        # 检查授权状态
        auth = state["authorizations"]["auth1"]
        self.assertEqual(auth["captured_amount"], 3000)
        self.assertEqual(auth["remaining_amount"], 2000)
        self.assertEqual(auth["status"], "pending")
        
        # 检查账户状态 - 冻结减少
        self.assertEqual(state["accounts"]["user1"]["frozen"], 2000)
        
        # 检查捕获记录
        capture = state["captures"]["cap1"]
        self.assertEqual(capture["amount"], 3000)
        self.assertEqual(capture["refundable_amount"], 3000)
    
    def test_capture_full_amount(self):
        """完全捕获"""
        self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 5000
        })
        
        state = self.ledger.get_ledger_state()
        auth = state["authorizations"]["auth1"]
        
        self.assertEqual(auth["status"], "captured")
        self.assertEqual(auth["remaining_amount"], 0)
        self.assertEqual(state["accounts"]["user1"]["frozen"], 0)
    
    def test_capture_partial_then_remaining(self):
        """分多次捕获"""
        # 第一次捕获
        self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 2000
        })
        
        # 第二次捕获
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "capture",
            "capture_id": "cap2",
            "auth_id": "auth1",
            "amount": 3000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        auth = state["authorizations"]["auth1"]
        self.assertEqual(auth["status"], "captured")
        self.assertEqual(auth["captured_amount"], 5000)
    
    def test_capture_exceeds_remaining(self):
        """捕获金额超过剩余可捕获金额"""
        result = self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 6000
        })
        
        self.assertFalse(result.success)
        self.assertIn("exceeds", result.message)
    
    def test_capture_nonexistent_auth(self):
        """捕获不存在的授权"""
        result = self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "nonexistent",
            "amount": 1000
        })
        
        self.assertFalse(result.success)
        self.assertIn("not found", result.message)
    
    def test_capture_duplicate_capture_id(self):
        """重复的 capture_id"""
        self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 2000
        })
        
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "capture",
            "capture_id": "cap1",  # 相同 ID
            "auth_id": "auth1",
            "amount": 1000
        })
        
        self.assertFalse(result.success)
        self.assertIn("already exists", result.message)


class TestVoid(unittest.TestCase):
    """测试撤销功能"""
    
    def setUp(self):
        self.ledger = PaymentLedger(current_time=1000)
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        self.ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 2000
        })
    
    def test_void_success(self):
        """成功撤销"""
        result = self.ledger.process_command({
            "command_id": "cmd3",
            "type": "void",
            "auth_id": "auth1"
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        # 检查授权状态
        auth = state["authorizations"]["auth1"]
        self.assertEqual(auth["status"], "voided")
        
        # 检查冻结金额已释放
        self.assertEqual(state["accounts"]["user1"]["frozen"], 0)
        self.assertEqual(state["accounts"]["user1"]["available"], 10000)
    
    def test_void_after_partial_capture(self):
        """部分捕获后撤销"""
        # 先捕获一部分
        self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 2000
        })
        
        # 撤销剩余部分
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "void",
            "auth_id": "auth1"
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        # 只释放未捕获的部分 (5000 - 2000 = 3000)
        self.assertEqual(state["accounts"]["user1"]["frozen"], 0)
        self.assertEqual(state["accounts"]["user1"]["available"], 10000)
    
    def test_void_already_captured(self):
        """完全捕获后不能撤销"""
        self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 5000
        })
        
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "void",
            "auth_id": "auth1"
        })
        
        self.assertFalse(result.success)
        self.assertIn("fully captured", result.message)
    
    def test_void_nonexistent_auth(self):
        """撤销不存在的授权"""
        result = self.ledger.process_command({
            "command_id": "cmd3",
            "type": "void",
            "auth_id": "nonexistent"
        })
        
        self.assertFalse(result.success)
        self.assertIn("not found", result.message)


class TestRefund(unittest.TestCase):
    """测试退款功能"""
    
    def setUp(self):
        self.ledger = PaymentLedger(current_time=1000)
        self.ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        self.ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 2000
        })
        self.ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 3000
        })
    
    def test_refund_success(self):
        """成功退款"""
        initial_balance = self.ledger.get_ledger_state()["accounts"]["user1"]["balance"]
        
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "refund",
            "refund_id": "ref1",
            "capture_id": "cap1",
            "amount": 1000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        # 检查余额增加
        self.assertEqual(state["accounts"]["user1"]["balance"], initial_balance + 1000)
        
        # 检查捕获状态
        capture = state["captures"]["cap1"]
        self.assertEqual(capture["refunded_amount"], 1000)
        self.assertEqual(capture["refundable_amount"], 2000)
        self.assertEqual(capture["status"], "partially_refunded")
    
    def test_refund_full_amount(self):
        """全额退款"""
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "refund",
            "refund_id": "ref1",
            "capture_id": "cap1",
            "amount": 3000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        capture = state["captures"]["cap1"]
        self.assertEqual(capture["status"], "refunded")
        self.assertEqual(capture["refundable_amount"], 0)
    
    def test_refund_exceeds_capture_amount(self):
        """退款金额超过可退款金额"""
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "refund",
            "refund_id": "ref1",
            "capture_id": "cap1",
            "amount": 5000
        })
        
        self.assertFalse(result.success)
        self.assertIn("exceeds", result.message)
    
    def test_refund_nonexistent_capture(self):
        """退还不存在的捕获"""
        result = self.ledger.process_command({
            "command_id": "cmd4",
            "type": "refund",
            "refund_id": "ref1",
            "capture_id": "nonexistent",
            "amount": 1000
        })
        
        self.assertFalse(result.success)
        self.assertIn("not found", result.message)
    
    def test_multiple_refunds(self):
        """多次退款"""
        self.ledger.process_command({
            "command_id": "cmd4",
            "type": "refund",
            "refund_id": "ref1",
            "capture_id": "cap1",
            "amount": 1000
        })
        
        result = self.ledger.process_command({
            "command_id": "cmd5",
            "type": "refund",
            "refund_id": "ref2",
            "capture_id": "cap1",
            "amount": 2000
        })
        
        self.assertTrue(result.success)
        state = self.ledger.get_ledger_state()
        
        capture = state["captures"]["cap1"]
        self.assertEqual(capture["refunded_amount"], 3000)
        self.assertEqual(capture["status"], "refunded")
        
        # 不能再退款
        result2 = self.ledger.process_command({
            "command_id": "cmd6",
            "type": "refund",
            "refund_id": "ref3",
            "capture_id": "cap1",
            "amount": 100
        })
        
        self.assertFalse(result2.success)


class TestExpiration(unittest.TestCase):
    """测试过期处理"""
    
    def test_expired_authorization_cannot_capture(self):
        """过期的授权不能捕获"""
        ledger = PaymentLedger(current_time=1000)
        
        ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        
        ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 1500  # 1500 时刻过期
        })
        
        # 时间前进到 1600，授权已过期
        ledger.set_current_time(1600)
        
        result = ledger.process_command({
            "command_id": "cmd3",
            "type": "capture",
            "capture_id": "cap1",
            "auth_id": "auth1",
            "amount": 3000
        })
        
        self.assertFalse(result.success)
        self.assertIn("expired", result.message)
        
        # 检查冻结金额已释放
        state = ledger.get_ledger_state()
        self.assertEqual(state["accounts"]["user1"]["frozen"], 0)
    
    def test_expired_authorization_cannot_void(self):
        """过期的授权不能撤销"""
        ledger = PaymentLedger(current_time=1000)
        
        ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 10000
        })
        
        ledger.process_command({
            "command_id": "cmd2",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 5000,
            "expires_at": 1500
        })
        
        ledger.set_current_time(1600)
        
        result = ledger.process_command({
            "command_id": "cmd3",
            "type": "void",
            "auth_id": "auth1"
        })
        
        self.assertFalse(result.success)
        self.assertIn("expired", result.message)


class TestIntegration(unittest.TestCase):
    """集成测试"""
    
    def test_full_workflow(self):
        """完整的支付流程测试"""
        ledger = PaymentLedger(current_time=1000)
        
        commands = [
            # 用户充值
            {"command_id": "cmd1", "type": "top_up", "account": "user1", "amount": 50000},
            {"command_id": "cmd2", "type": "top_up", "account": "user2", "amount": 30000},
            
            # user1 授权两笔
            {"command_id": "cmd3", "type": "authorize", "auth_id": "auth1", "account": "user1", "amount": 10000, "expires_at": 2000},
            {"command_id": "cmd4", "type": "authorize", "auth_id": "auth2", "account": "user1", "amount": 15000, "expires_at": 2000},
            
            # 捕获第一笔的部分
            {"command_id": "cmd5", "type": "capture", "capture_id": "cap1", "auth_id": "auth1", "amount": 6000},
            
            # 撤销第二笔
            {"command_id": "cmd6", "type": "void", "auth_id": "auth2"},
            
            # 对第一笔进行退款
            {"command_id": "cmd7", "type": "refund", "refund_id": "ref1", "capture_id": "cap1", "amount": 2000},
            
            # 完全捕获第一笔剩余部分
            {"command_id": "cmd8", "type": "capture", "capture_id": "cap2", "auth_id": "auth1", "amount": 4000},
        ]
        
        result = ledger.process_commands(commands)
        
        # 验证所有命令都成功
        for cmd_result in result["results"]:
            self.assertTrue(cmd_result["success"], f"Command {cmd_result['command_id']} failed: {cmd_result['message']}")
        
        state = result["ledger_state"]
        
        # 验证最终状态
        # user1: 充值 50000, 退款 2000, 实际消费 10000 (6000+4000-2000)
        # 但 balance 应该是 50000 + 2000 = 52000 (因为 capture 只是解冻，refund 才真正加钱)
        # 等等，让我重新思考...
        # 初始: balance=50000, frozen=0
        # auth1: frozen += 10000 -> balance=50000, frozen=10000
        # auth2: frozen += 15000 -> balance=50000, frozen=25000
        # cap1: captured 6000, frozen -= 6000 -> balance=50000, frozen=19000
        # void auth2: release 15000 -> balance=50000, frozen=4000
        # ref1: refund 2000 -> balance=52000, frozen=4000
        # cap2: captured 4000, frozen -= 4000 -> balance=52000, frozen=0
        
        self.assertEqual(state["accounts"]["user1"]["balance"], 52000)
        self.assertEqual(state["accounts"]["user1"]["frozen"], 0)
        
        # auth1 应该完全捕获
        self.assertEqual(state["authorizations"]["auth1"]["status"], "captured")
        self.assertEqual(state["authorizations"]["auth1"]["captured_amount"], 10000)
        
        # auth2 应该被撤销
        self.assertEqual(state["authorizations"]["auth2"]["status"], "voided")
        
        # cap1 应该部分退款
        self.assertEqual(state["captures"]["cap1"]["refunded_amount"], 2000)
        
        # cap2 应该全额
        self.assertEqual(state["captures"]["cap2"]["amount"], 4000)
    
    def test_process_batch_with_failure(self):
        """批量处理中包含失败命令"""
        ledger = PaymentLedger(current_time=1000)
        
        commands = [
            {"command_id": "cmd1", "type": "top_up", "account": "user1", "amount": 5000},
            {"command_id": "cmd2", "type": "authorize", "auth_id": "auth1", "account": "user1", "amount": 10000, "expires_at": 2000},  # 会失败
            {"command_id": "cmd3", "type": "authorize", "auth_id": "auth2", "account": "user1", "amount": 3000, "expires_at": 2000},
        ]
        
        result = ledger.process_commands(commands)
        
        # cmd1 成功
        self.assertTrue(result["results"][0]["success"])
        # cmd2 失败（余额不足）
        self.assertFalse(result["results"][1]["success"])
        # cmd3 成功
        self.assertTrue(result["results"][2]["success"])
        
        state = result["ledger_state"]
        # 只有 auth2 存在
        self.assertNotIn("auth1", state["authorizations"])
        self.assertIn("auth2", state["authorizations"])


class TestEdgeCases(unittest.TestCase):
    """边界情况测试"""
    
    def test_missing_command_id(self):
        """缺少 command_id"""
        ledger = PaymentLedger()
        result = ledger.process_command({
            "type": "top_up",
            "account": "user1",
            "amount": 1000
        })
        
        self.assertFalse(result.success)
        self.assertIn("Missing command_id", result.message)
    
    def test_unknown_command_type(self):
        """未知的命令类型"""
        ledger = PaymentLedger()
        result = ledger.process_command({
            "command_id": "cmd1",
            "type": "unknown_type"
        })
        
        self.assertFalse(result.success)
        self.assertIn("Unknown command type", result.message)
    
    def test_negative_amount(self):
        """负数金额"""
        ledger = PaymentLedger()
        result = ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": -100
        })
        
        self.assertFalse(result.success)
    
    def test_float_amount(self):
        """浮点数金额（应该失败，因为要求整数）"""
        ledger = PaymentLedger()
        result = ledger.process_command({
            "command_id": "cmd1",
            "type": "top_up",
            "account": "user1",
            "amount": 100.5
        })
        
        self.assertFalse(result.success)
    
    def test_multiple_accounts(self):
        """多个账户独立管理"""
        ledger = PaymentLedger(current_time=1000)
        
        ledger.process_command({"command_id": "cmd1", "type": "top_up", "account": "user1", "amount": 10000})
        ledger.process_command({"command_id": "cmd2", "type": "top_up", "account": "user2", "amount": 5000})
        
        # user1 授权不影响 user2
        ledger.process_command({
            "command_id": "cmd3",
            "type": "authorize",
            "auth_id": "auth1",
            "account": "user1",
            "amount": 8000,
            "expires_at": 2000
        })
        
        state = ledger.get_ledger_state()
        self.assertEqual(state["accounts"]["user1"]["available"], 2000)
        self.assertEqual(state["accounts"]["user2"]["available"], 5000)


if __name__ == "__main__":
    unittest.main()
