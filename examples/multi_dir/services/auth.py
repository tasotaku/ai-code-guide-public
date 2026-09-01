"""認証サービス。ユーザー登録・ログイン・トークン管理を行う。"""

import hashlib
import secrets
from typing import Optional

from models.user import User
from utils.validators import validate_email

# インメモリストレージ
_users: dict[str, User] = {}
_tokens: dict[str, str] = {}  # token -> email


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def register_user(email: str, password: str, name: str = "") -> dict:
    """ユーザー登録。バリデーション後に保存する。"""
    if not validate_email(email):
        return {"ok": False, "error": "invalid email"}
    if email in _users:
        return {"ok": False, "error": "already registered"}

    user = User(email, _hash_password(password), name)
    _users[email] = user
    return {"ok": True, "user": user.to_dict()}


def login_user(email: str, password: str) -> dict:
    """ログイン処理。成功したらトークンを返す。"""
    user = _users.get(email)
    if not user or user.password_hash != _hash_password(password):
        return {"ok": False, "error": "invalid credentials"}

    token = secrets.token_hex(16)
    _tokens[token] = email
    return {"ok": True, "token": token}


def get_user_by_token(token: str) -> Optional[User]:
    """トークンからユーザーを取得する。"""
    email = _tokens.get(token)
    return _users.get(email) if email else None
