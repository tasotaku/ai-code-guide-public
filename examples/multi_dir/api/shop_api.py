"""ショップAPI。商品一覧取得・注文・キャンセルのエンドポイントを処理する。"""

from services import auth as auth_service
from services import catalog as catalog_service
from services import order as order_service
from utils.formatters import format_response


def _get_user(token: str) -> dict | None:
    """トークンからユーザーを取得。未認証なら None を返す。"""
    return auth_service.get_user_by_token(token)


def handle_list_products(headers: dict) -> dict:
    """GET /shop/products ハンドラ。"""
    products = catalog_service.list_products()
    return format_response(200, data={"products": products})


def handle_get_product(product_id: str) -> dict:
    """GET /shop/products/:id ハンドラ。"""
    product = catalog_service.get_product(product_id)
    if not product:
        return format_response(404, error="product not found")
    return format_response(200, data=product)


def handle_place_order(body: dict, headers: dict) -> dict:
    """POST /shop/orders ハンドラ。認証必須。"""
    token = headers.get("Authorization", "").replace("Bearer ", "")
    user = _get_user(token)
    if not user:
        return format_response(401, error="unauthorized")

    items = body.get("items", [])
    result = order_service.place_order(user.email, items)
    if not result["ok"]:
        return format_response(400, error=result["error"])

    return format_response(201, data=result["order"])


def handle_cancel_order(order_id: str, headers: dict) -> dict:
    """DELETE /shop/orders/:id ハンドラ。認証必須。"""
    token = headers.get("Authorization", "").replace("Bearer ", "")
    if not _get_user(token):
        return format_response(401, error="unauthorized")

    result = order_service.cancel_order(order_id)
    if not result["ok"]:
        return format_response(400, error=result["error"])

    return format_response(200, data={"cancelled": True})
