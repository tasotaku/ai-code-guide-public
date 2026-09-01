"""商品カタログサービス。商品の検索・在庫管理を行う。"""

from typing import Optional

from models.product import Product
from utils.validators import validate_quantity

# インメモリストレージ
_products: dict[str, Product] = {
    "p001": Product("p001", "Widget A", 1200.0, 50),
    "p002": Product("p002", "Widget B", 3500.0, 20),
    "p003": Product("p003", "Gadget X", 8800.0, 5),
}


def list_products() -> list[dict]:
    """利用可能な全商品を返す。"""
    return [p.to_dict() for p in _products.values() if p.is_available()]


def get_product(product_id: str) -> Optional[dict]:
    """商品IDで商品を取得する。"""
    product = _products.get(product_id)
    return product.to_dict() if product else None


def check_stock(product_id: str, quantity: int) -> bool:
    """在庫が十分かチェックする。"""
    if not validate_quantity(quantity):
        return False
    product = _products.get(product_id)
    return product is not None and product.stock >= quantity


def reserve_stock(product_id: str, quantity: int) -> bool:
    """在庫を引き当てる。在庫不足なら False を返す。"""
    product = _products.get(product_id)
    if not product or product.stock < quantity:
        return False
    product.stock -= quantity
    return True
