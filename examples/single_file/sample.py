import hashlib
import re
import jwt
import datetime
from typing import Optional

SECRET_KEY = "dev-secret-key"
DB: dict[str, dict] = {}


def register_user(email: str, password: str) -> Optional[str]:
    # 入力バリデーション
    if not re.match(r"^[\w\.-]+@[\w\.-]+\.\w{2,}$", email):
        return None
    if email in DB:
        return None

    # パスワードハッシュ化 & 保存
    hashed = hash_password(password)
    DB[email] = {"password_hash": hashed, "created_at": datetime.datetime.utcnow()}
    return email


def authenticate_user(email: str, password: str) -> Optional[str]:
    # ユーザー存在確認
    user = DB.get(email)
    if not user:
        return None

    # パスワード照合
    if hash_password(password) != user["password_hash"]:
        return None

    # JWTトークン生成
    payload = {
        "email": email,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    }
    token = jwt.encode(payload, SECRET_KEY, algorithm="HS256")
    return token


def verify_token(token: str) -> Optional[str]:
    # トークン検証
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None

    # ユーザー存在確認
    email = payload.get("email")
    if not email or email not in DB:
        return None
    return email


def hash_password(password: str) -> str:
    salt = "static_salt"
    return hashlib.sha256((password + salt).encode()).hexdigest()


if __name__ == "__main__":
    # ユーザー登録
    print(register_user("alice@example.com", "pass123"))
    print(register_user("invalid-email", "pass"))
    print(register_user("alice@example.com", "duplicate"))

    # ログイン & トークン取得
    token = authenticate_user("alice@example.com", "pass123")
    print(f"token: {token[:20]}..." if token else "login failed")

    # トークン検証
    email = verify_token(token) if token else None
    print(f"verified: {email}")
