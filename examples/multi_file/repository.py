"""データアクセス層。インメモリDBとして辞書を使う。"""

import hashlib
from typing import Optional

from models import Order, User

# インメモリDB
_users: dict[str, User] = {}
_orders: list[Order] = []


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def save_user(email: str, password: str) -> Optional[User]:
    """ユーザーを保存する。既存メールは None を返す。"""
    if email in _users:
        return None

    user = User(email, hash_password(password))
    _users[email] = user
    return user


def get_user(email: str) -> Optional[User]:
    """メールアドレスでユーザーを取得する。"""
    return _users.get(email)


def verify_password(email: str, password: str) -> bool:
    """パスワードを照合する。ユーザーが存在しない場合も False を返す。"""
    user = get_user(email)
    if not user:
        return False
    return user.password_hash == hash_password(password)


def save_order(user_email: str, item: str, quantity: int) -> Order:
    """注文を保存して返す。"""
    order = Order(user_email, item, quantity)
    _orders.append(order)
    return order


def get_orders(user_email: str) -> list[Order]:
    """ユーザーの注文一覧を返す。"""
    return [o for o in _orders if o.user_email == user_email]
