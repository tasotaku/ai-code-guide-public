"""HTTPリクエストハンドラ層。リクエストを受け取りサービス層に委譲する。"""

from typing import Any

import service


def handle_register(body: dict[str, Any]) -> dict:
    """POST /register ハンドラ。"""
    email = body.get("email", "")
    password = body.get("password", "")

    if not email or not password:
        return {"status": 400, "body": {"error": "email and password required"}}

    result = service.register_user(email, password)
    if not result["ok"]:
        return {"status": 400, "body": {"error": result["error"]}}

    return {"status": 201, "body": result["user"]}


def handle_login(body: dict[str, Any]) -> dict:
    """POST /login ハンドラ。"""
    email = body.get("email", "")
    password = body.get("password", "")

    if not email or not password:
        return {"status": 400, "body": {"error": "email and password required"}}

    result = service.login_user(email, password)
    if not result["ok"]:
        return {"status": 401, "body": {"error": result["error"]}}

    return {"status": 200, "body": {"token": result["token"]}}


def handle_place_order(body: dict[str, Any], email: str) -> dict:
    """POST /orders ハンドラ。"""
    item = body.get("item", "")
    quantity = int(body.get("quantity", 0))

    if not item:
        return {"status": 400, "body": {"error": "item required"}}

    result = service.place_order(email, item, quantity)
    if not result["ok"]:
        return {"status": 400, "body": {"error": result["error"]}}

    return {"status": 201, "body": result["order"]}


def handle_get_orders(email: str) -> dict:
    """GET /orders ハンドラ。"""
    result = service.get_user_orders(email)
    if not result["ok"]:
        return {"status": 404, "body": {"error": result["error"]}}

    return {"status": 200, "body": {"orders": result["orders"]}}
