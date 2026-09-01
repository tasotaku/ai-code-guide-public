"""データモデル定義。他のモジュールから import して使う。"""

import datetime
from typing import Optional


class User:
    def __init__(self, email: str, password_hash: str) -> None:
        self.email = email
        self.password_hash = password_hash
        self.created_at = datetime.datetime.utcnow()

    def to_dict(self) -> dict:
        return {
            "email": self.email,
            "created_at": self.created_at.isoformat(),
        }


class Order:
    def __init__(self, user_email: str, item: str, quantity: int) -> None:
        self.user_email = user_email
        self.item = item
        self.quantity = quantity
        self.status = "pending"
        self.created_at = datetime.datetime.utcnow()

    def to_dict(self) -> dict:
        return {
            "user_email": self.user_email,
            "item": self.item,
            "quantity": self.quantity,
            "status": self.status,
        }


def validate_email(email: str) -> bool:
    """メールアドレスの基本バリデーション。"""
    return "@" in email and "." in email.split("@")[-1]
