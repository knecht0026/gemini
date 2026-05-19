"""
Payment Ledger - 支付授权账本系统

主要设计：
1. Account: 管理账户余额和冻结金额
2. Authorization: 管理授权状态（pending/captured/voided/expired）
3. Capture: 管理捕获状态和退款
4. PaymentLedger: 核心类，处理所有命令并维护账本状态

关键特性：
- 命令去重：通过 command_id 确保幂等性
- 金额验证：所有金额必须为正整数
- 状态流转：严格的状态机控制
- 冻结机制：authorize 时冻结余额，capture/void 时释放
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple, Any
from datetime import datetime


class AuthStatus(Enum):
    PENDING = "pending"
    CAPTURED = "captured"
    VOIDED = "voided"
    EXPIRED = "expired"


class CaptureStatus(Enum):
    CAPTURED = "captured"
    REFUNDED = "refunded"
    PARTIALLY_REFUNDED = "partially_refunded"


@dataclass
class Account:
    balance: int = 0  # 可用余额（分）
    frozen: int = 0   # 冻结金额（分）
    
    def available_balance(self) -> int:
        return self.balance - self.frozen
    
    def to_dict(self) -> Dict[str, int]:
        return {
            "balance": self.balance,
            "frozen": self.frozen,
            "available": self.available_balance()
        }


@dataclass
class Authorization:
    auth_id: str
    account: str
    amount: int
    expires_at: int  # 时间戳
    captured_amount: int = 0
    status: AuthStatus = AuthStatus.PENDING
    created_at: int = 0
    
    def remaining_amount(self) -> int:
        """未捕获的金额"""
        if self.status in [AuthStatus.VOIDED, AuthStatus.EXPIRED]:
            return 0
        return self.amount - self.captured_amount
    
    def is_expired(self, current_time: int) -> bool:
        return current_time > self.expires_at
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "auth_id": self.auth_id,
            "account": self.account,
            "amount": self.amount,
            "expires_at": self.expires_at,
            "captured_amount": self.captured_amount,
            "remaining_amount": self.remaining_amount(),
            "status": self.status.value,
            "created_at": self.created_at
        }


@dataclass
class Capture:
    capture_id: str
    auth_id: str
    amount: int
    refunded_amount: int = 0
    status: CaptureStatus = CaptureStatus.CAPTURED
    
    def refundable_amount(self) -> int:
        """可退款金额"""
        return self.amount - self.refunded_amount
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "capture_id": self.capture_id,
            "auth_id": self.auth_id,
            "amount": self.amount,
            "refunded_amount": self.refunded_amount,
            "refundable_amount": self.refundable_amount(),
            "status": self.status.value
        }


@dataclass
class CommandResult:
    command_id: str
    command_type: str
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "command_id": self.command_id,
            "command_type": self.command_type,
            "success": self.success,
            "message": self.message
        }
        if self.data is not None:
            result["data"] = self.data
        return result


class PaymentLedger:
    def __init__(self, current_time: int = 0):
        self.accounts: Dict[str, Account] = {}
        self.authorizations: Dict[str, Authorization] = {}
        self.captures: Dict[str, Capture] = {}
        self.processed_command_ids: set = set()
        self.current_time = current_time
        self.results: List[CommandResult] = []
    
    def set_current_time(self, time: int):
        """设置当前时间（用于测试过期）"""
        self.current_time = time
    
    def _get_or_create_account(self, account_id: str) -> Account:
        if account_id not in self.accounts:
            self.accounts[account_id] = Account()
        return self.accounts[account_id]
    
    def _check_command_duplicate(self, command_id: str) -> bool:
        """检查命令是否重复"""
        if command_id in self.processed_command_ids:
            return True
        self.processed_command_ids.add(command_id)
        return False
    
    def _validate_positive_amount(self, amount: int) -> Tuple[bool, str]:
        """验证金额为正整数"""
        if not isinstance(amount, int) or amount <= 0:
            return False, "Amount must be a positive integer"
        return True, ""
    
    def _expire_authorizations(self):
        """将所有过期的授权标记为 expired"""
        for auth in self.authorizations.values():
            if auth.status == AuthStatus.PENDING and auth.is_expired(self.current_time):
                # 计算未捕获的金额（即需要释放的冻结金额）
                remaining = auth.amount - auth.captured_amount
                auth.status = AuthStatus.EXPIRED
                # 释放冻结金额
                account = self._get_or_create_account(auth.account)
                account.frozen -= remaining
    
    def process_command(self, command: Dict[str, Any]) -> CommandResult:
        """处理单个命令"""
        command_id = command.get("command_id")
        command_type = command.get("type")
        
        # 检查命令ID
        if command_id is None:
            return CommandResult(
                command_id="unknown",
                command_type=command_type or "unknown",
                success=False,
                message="Missing command_id"
            )
        
        # 检查重复
        if self._check_command_duplicate(command_id):
            return CommandResult(
                command_id=command_id,
                command_type=command_type,
                success=False,
                message=f"Duplicate command_id: {command_id}"
            )
        
        # 先处理过期
        self._expire_authorizations()
        
        # 分发到具体处理函数
        if command_type == "top_up":
            return self._process_top_up(command)
        elif command_type == "authorize":
            return self._process_authorize(command)
        elif command_type == "capture":
            return self._process_capture(command)
        elif command_type == "void":
            return self._process_void(command)
        elif command_type == "refund":
            return self._process_refund(command)
        else:
            return CommandResult(
                command_id=command_id,
                command_type=command_type,
                success=False,
                message=f"Unknown command type: {command_type}"
            )
    
    def _process_top_up(self, command: Dict[str, Any]) -> CommandResult:
        account_id = command.get("account")
        amount = command.get("amount")
        
        if not account_id:
            return CommandResult(
                command_id=command["command_id"],
                command_type="top_up",
                success=False,
                message="Missing account"
            )
        
        valid, msg = self._validate_positive_amount(amount)
        if not valid:
            return CommandResult(
                command_id=command["command_id"],
                command_type="top_up",
                success=False,
                message=msg
            )
        
        account = self._get_or_create_account(account_id)
        account.balance += amount
        
        return CommandResult(
            command_id=command["command_id"],
            command_type="top_up",
            success=True,
            message=f"Top up {amount} to account {account_id}",
            data={"account": account_id, "new_balance": account.balance}
        )
    
    def _process_authorize(self, command: Dict[str, Any]) -> CommandResult:
        auth_id = command.get("auth_id")
        account_id = command.get("account")
        amount = command.get("amount")
        expires_at = command.get("expires_at")
        
        if not all([auth_id, account_id, amount is not None, expires_at is not None]):
            return CommandResult(
                command_id=command["command_id"],
                command_type="authorize",
                success=False,
                message="Missing required fields"
            )
        
        valid, msg = self._validate_positive_amount(amount)
        if not valid:
            return CommandResult(
                command_id=command["command_id"],
                command_type="authorize",
                success=False,
                message=msg
            )
        
        if auth_id in self.authorizations:
            return CommandResult(
                command_id=command["command_id"],
                command_type="authorize",
                success=False,
                message=f"Authorization {auth_id} already exists"
            )
        
        account = self._get_or_create_account(account_id)
        
        # 检查余额是否足够
        if account.available_balance() < amount:
            return CommandResult(
                command_id=command["command_id"],
                command_type="authorize",
                success=False,
                message=f"Insufficient balance. Available: {account.available_balance()}, Required: {amount}"
            )
        
        # 创建授权并冻结金额
        auth = Authorization(
            auth_id=auth_id,
            account=account_id,
            amount=amount,
            expires_at=expires_at,
            created_at=self.current_time
        )
        self.authorizations[auth_id] = auth
        account.frozen += amount
        
        return CommandResult(
            command_id=command["command_id"],
            command_type="authorize",
            success=True,
            message=f"Authorized {amount} for account {account_id}",
            data=auth.to_dict()
        )
    
    def _process_capture(self, command: Dict[str, Any]) -> CommandResult:
        capture_id = command.get("capture_id")
        auth_id = command.get("auth_id")
        amount = command.get("amount")
        
        if not all([capture_id, auth_id, amount is not None]):
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message="Missing required fields"
            )
        
        valid, msg = self._validate_positive_amount(amount)
        if not valid:
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message=msg
            )
        
        if capture_id in self.captures:
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message=f"Capture {capture_id} already exists"
            )
        
        if auth_id not in self.authorizations:
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message=f"Authorization {auth_id} not found"
            )
        
        auth = self.authorizations[auth_id]
        
        # 检查授权状态
        if auth.status == AuthStatus.EXPIRED:
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message=f"Authorization {auth_id} has expired"
            )
        
        if auth.status == AuthStatus.VOIDED:
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message=f"Authorization {auth_id} has been voided"
            )
        
        if auth.status == AuthStatus.CAPTURED:
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message=f"Authorization {auth_id} has been fully captured"
            )
        
        # 检查剩余可捕获金额
        remaining = auth.remaining_amount()
        if amount > remaining:
            return CommandResult(
                command_id=command["command_id"],
                command_type="capture",
                success=False,
                message=f"Capture amount {amount} exceeds remaining authorization amount {remaining}"
            )
        
        # 执行捕获
        account = self._get_or_create_account(auth.account)
        
        # 更新授权
        auth.captured_amount += amount
        account.frozen -= amount  # 释放冻结的金额
        
        # 如果完全捕获，更新状态
        if auth.captured_amount >= auth.amount:
            auth.status = AuthStatus.CAPTURED
        
        # 创建捕获记录
        capture = Capture(
            capture_id=capture_id,
            auth_id=auth_id,
            amount=amount
        )
        self.captures[capture_id] = capture
        
        return CommandResult(
            command_id=command["command_id"],
            command_type="capture",
            success=True,
            message=f"Captured {amount} from authorization {auth_id}",
            data=capture.to_dict()
        )
    
    def _process_void(self, command: Dict[str, Any]) -> CommandResult:
        auth_id = command.get("auth_id")
        
        if not auth_id:
            return CommandResult(
                command_id=command["command_id"],
                command_type="void",
                success=False,
                message="Missing auth_id"
            )
        
        if auth_id not in self.authorizations:
            return CommandResult(
                command_id=command["command_id"],
                command_type="void",
                success=False,
                message=f"Authorization {auth_id} not found"
            )
        
        auth = self.authorizations[auth_id]
        
        # 检查授权状态
        if auth.status == AuthStatus.EXPIRED:
            return CommandResult(
                command_id=command["command_id"],
                command_type="void",
                success=False,
                message=f"Authorization {auth_id} has already expired"
            )
        
        if auth.status == AuthStatus.VOIDED:
            return CommandResult(
                command_id=command["command_id"],
                command_type="void",
                success=False,
                message=f"Authorization {auth_id} has already been voided"
            )
        
        if auth.status == AuthStatus.CAPTURED:
            return CommandResult(
                command_id=command["command_id"],
                command_type="void",
                success=False,
                message=f"Authorization {auth_id} has been fully captured, nothing to void"
            )
        
        # 执行 void，释放未捕获的金额
        account = self._get_or_create_account(auth.account)
        remaining = auth.remaining_amount()
        account.frozen -= remaining
        auth.status = AuthStatus.VOIDED
        
        return CommandResult(
            command_id=command["command_id"],
            command_type="void",
            success=True,
            message=f"Voided authorization {auth_id}, released {remaining}",
            data={"auth_id": auth_id, "released_amount": remaining}
        )
    
    def _process_refund(self, command: Dict[str, Any]) -> CommandResult:
        refund_id = command.get("refund_id")
        capture_id = command.get("capture_id")
        amount = command.get("amount")
        
        if not all([refund_id, capture_id, amount is not None]):
            return CommandResult(
                command_id=command["command_id"],
                command_type="refund",
                success=False,
                message="Missing required fields"
            )
        
        valid, msg = self._validate_positive_amount(amount)
        if not valid:
            return CommandResult(
                command_id=command["command_id"],
                command_type="refund",
                success=False,
                message=msg
            )
        
        if capture_id not in self.captures:
            return CommandResult(
                command_id=command["command_id"],
                command_type="refund",
                success=False,
                message=f"Capture {capture_id} not found"
            )
        
        capture = self.captures[capture_id]
        
        # 检查可退款金额
        refundable = capture.refundable_amount()
        if amount > refundable:
            return CommandResult(
                command_id=command["command_id"],
                command_type="refund",
                success=False,
                message=f"Refund amount {amount} exceeds refundable amount {refundable}"
            )
        
        # 执行退款
        capture.refunded_amount += amount
        
        # 更新捕获状态
        if capture.refunded_amount >= capture.amount:
            capture.status = CaptureStatus.REFUNDED
        else:
            capture.status = CaptureStatus.PARTIALLY_REFUNDED
        
        # 增加账户余额（退款回到账户）
        auth = self.authorizations.get(capture.auth_id)
        if auth:
            account = self._get_or_create_account(auth.account)
            account.balance += amount
        
        return CommandResult(
            command_id=command["command_id"],
            command_type="refund",
            success=True,
            message=f"Refunded {amount} for capture {capture_id}",
            data={
                "refund_id": refund_id,
                "capture_id": capture_id,
                "amount": amount,
                "capture_status": capture.status.value
            }
        )
    
    def get_ledger_state(self) -> Dict[str, Any]:
        """获取账本当前状态"""
        # 先处理过期
        self._expire_authorizations()
        
        return {
            "accounts": {k: v.to_dict() for k, v in self.accounts.items()},
            "authorizations": {k: v.to_dict() for k, v in self.authorizations.items()},
            "captures": {k: v.to_dict() for k, v in self.captures.items()},
            "processed_commands_count": len(self.processed_command_ids)
        }
    
    def process_commands(self, commands: List[Dict[str, Any]]) -> Dict[str, Any]:
        """处理一批命令并返回结果"""
        results = []
        for command in commands:
            result = self.process_command(command)
            results.append(result.to_dict())
        
        return {
            "results": results,
            "ledger_state": self.get_ledger_state()
        }
