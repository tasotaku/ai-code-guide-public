"""ビジネスロジック層。バリデーション・認証・注文処理を担う。"""

from typing import Optional

import repository
from models import validate_email


def register_user(email: str, password: str) -> dict:
    """ユーザー登録。バリデーション後にリポジトリへ委譲する。"""
    # 入力バリデーション
    if not validate_email(email):
        return {"ok": False, "error": "invalid email"}
    if len(password) < 6:
        return {"ok": False, "error": "password too short"}

    # リポジトリへ保存
    user = repository.save_user(email, password)
    if not user:
        return {"ok": False, "error": "email already registered"}

    return {"ok": True, "user": user.to_dict()}


def login_user(email: str, password: str) -> dict:
    """ログイン処理。パスワード照合後にセッショントークンを返す。"""
    # パスワード照合
    if not repository.verify_password(email, password):
        return {"ok": False, "error": "invalid credentials"}

    # セッショントークン生成（簡易実装）
    token = f"tok_{email}_{hash(email + password) % 10**8:08d}"
    return {"ok": True, "token": token}


def place_order(email: str, item: str, quantity: int) -> dict:
    """注文を受け付ける。ユーザー存在確認後に保存する。"""
    # ユーザー存在確認
    user = repository.get_user(email)
    if not user:
        return {"ok": False, "error": "user not found"}

    # 数量バリデーション
    if quantity <= 0:
        return {"ok": False, "error": "quantity must be positive"}

    # 注文保存
    order = repository.save_order(email, item, quantity)
    return {"ok": True, "order": order.to_dict()}


def get_user_orders(email: str) -> dict:
    """ユーザーの注文一覧を返す。"""
    user = repository.get_user(email)
    if not user:
        return {"ok": False, "error": "user not found"}

    orders = repository.get_orders(email)
    return {"ok": True, "orders": [o.to_dict() for o in orders]}
