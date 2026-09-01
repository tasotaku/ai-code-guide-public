"""認証API。ユーザー登録・ログインのエンドポイントを処理する。"""

from services import auth as auth_service
from utils.formatters import format_response


def handle_register(body: dict) -> dict:
    """POST /auth/register ハンドラ。"""
    email = body.get("email", "")
    password = body.get("password", "")
    name = body.get("name", "")

    if not email or not password:
        return format_response(400, error="email and password required")

    result = auth_service.register_user(email, password, name)
    if not result["ok"]:
        return format_response(400, error=result["error"])

    return format_response(201, data=result["user"])


def handle_login(body: dict) -> dict:
    """POST /auth/login ハンドラ。"""
    email = body.get("email", "")
    password = body.get("password", "")

    if not email or not password:
        return format_response(400, error="email and password required")

    result = auth_service.login_user(email, password)
    if not result["ok"]:
        return format_response(401, error=result["error"])

    return format_response(200, data={"token": result["token"]})
