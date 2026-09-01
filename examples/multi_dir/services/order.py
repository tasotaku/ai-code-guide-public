"""注文サービス。注文の作成・キャンセル・照会を行う。"""

import uuid
from typing import Optional

from models.order import Order
from services import catalog as catalog_service

# インメモリストレージ
_orders: dict[str, Order] = {}


def place_order(user_email: str, items: list[dict]) -> dict:
    """注文を作成する。在庫確認後に引き当てを行う。"""
    if not items:
        return {"ok": False, "error": "no items"}

    # 在庫確認（全アイテム一括チェック）
    for item in items:
        if not catalog_service.check_stock(item["product_id"], item["quantity"]):
            return {"ok": False, "error": f"insufficient stock: {item['product_id']}"}

    # 在庫引き当て & 注文生成
    order = Order(str(uuid.uuid4()), user_email)
    for item in items:
        product = catalog_service.get_product(item["product_id"])
        if not product:
            return {"ok": False, "error": f"product not found: {item['product_id']}"}
        catalog_service.reserve_stock(item["product_id"], item["quantity"])
        order.add_item(item["product_id"], item["quantity"], product["price"])

    _orders[order.order_id] = order
    return {"ok": True, "order": order.to_dict()}


def cancel_order(order_id: str) -> dict:
    """注文をキャンセルする。pending 状態のみ可能。"""
    order = _orders.get(order_id)
    if not order:
        return {"ok": False, "error": "order not found"}
    if order.status != "pending":
        return {"ok": False, "error": "cannot cancel non-pending order"}

    order.status = "cancelled"
    return {"ok": True}


def get_order(order_id: str) -> Optional[dict]:
    """注文IDで注文を取得する。"""
    order = _orders.get(order_id)
    return order.to_dict() if order else None
