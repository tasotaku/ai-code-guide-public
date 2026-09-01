"""
inventory_system.py — 在庫管理システム（フローチャートテスト用: ~1000行）
"""

from __future__ import annotations

import csv
import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import Enum
from typing import Iterator

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums / constants
# ---------------------------------------------------------------------------

class Category(Enum):
    ELECTRONICS = "electronics"
    CLOTHING = "clothing"
    FOOD = "food"
    FURNITURE = "furniture"
    SPORTS = "sports"
    OTHER = "other"


class StockStatus(Enum):
    IN_STOCK = "in_stock"
    LOW_STOCK = "low_stock"
    OUT_OF_STOCK = "out_of_stock"
    DISCONTINUED = "discontinued"


class OrderStatus(Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    SHIPPED = "shipped"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"
    RETURNED = "returned"


LOW_STOCK_THRESHOLD = 10
REORDER_MULTIPLIER = 3
TAX_RATE = 0.10
MAX_DISCOUNT_RATE = 0.50


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Price:
    amount: float
    currency: str = "JPY"

    def __post_init__(self) -> None:
        if self.amount < 0:
            raise ValueError(f"Price cannot be negative: {self.amount}")

    def with_tax(self) -> Price:
        return Price(round(self.amount * (1 + TAX_RATE), 2), self.currency)

    def discounted(self, rate: float) -> Price:
        if not 0 <= rate <= MAX_DISCOUNT_RATE:
            raise ValueError(f"Discount rate must be 0–{MAX_DISCOUNT_RATE}: {rate}")
        return Price(round(self.amount * (1 - rate), 2), self.currency)

    def __add__(self, other: Price) -> Price:
        if self.currency != other.currency:
            raise ValueError("Cannot add prices with different currencies")
        return Price(self.amount + other.amount, self.currency)

    def __mul__(self, qty: int) -> Price:
        return Price(self.amount * qty, self.currency)

    def __str__(self) -> str:
        return f"{self.currency} {self.amount:,.2f}"


@dataclass
class Supplier:
    supplier_id: str
    name: str
    contact_email: str
    phone: str
    address: str
    lead_days: int = 7
    active: bool = True

    def is_reachable(self) -> bool:
        return self.active and bool(self.contact_email)

    def expected_delivery(self, order_date: date) -> date:
        return order_date + timedelta(days=self.lead_days)


@dataclass
class Product:
    product_id: str
    name: str
    category: Category
    price: Price
    supplier: Supplier
    stock: int = 0
    reorder_point: int = LOW_STOCK_THRESHOLD
    reorder_qty: int = 0
    description: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    discontinued: bool = False

    def __post_init__(self) -> None:
        if self.reorder_qty == 0:
            self.reorder_qty = self.reorder_point * REORDER_MULTIPLIER

    @property
    def status(self) -> StockStatus:
        if self.discontinued:
            return StockStatus.DISCONTINUED
        if self.stock == 0:
            return StockStatus.OUT_OF_STOCK
        if self.stock <= self.reorder_point:
            return StockStatus.LOW_STOCK
        return StockStatus.IN_STOCK

    def needs_reorder(self) -> bool:
        return (
            not self.discontinued
            and self.stock <= self.reorder_point
        )

    def apply_stock_change(self, delta: int) -> None:
        new_stock = self.stock + delta
        if new_stock < 0:
            raise ValueError(
                f"Stock cannot go negative for {self.product_id}: "
                f"current={self.stock}, delta={delta}"
            )
        self.stock = new_stock

    def matches_tag(self, tag: str) -> bool:
        return tag.lower() in [t.lower() for t in self.tags]

    def to_dict(self) -> dict:
        return {
            "product_id": self.product_id,
            "name": self.name,
            "category": self.category.value,
            "price": self.price.amount,
            "currency": self.price.currency,
            "stock": self.stock,
            "status": self.status.value,
            "supplier_id": self.supplier.supplier_id,
            "tags": self.tags,
            "discontinued": self.discontinued,
        }


@dataclass
class OrderLine:
    product: Product
    qty: int
    unit_price: Price
    discount_rate: float = 0.0

    @property
    def subtotal(self) -> Price:
        return self.unit_price.discounted(self.discount_rate) * self.qty

    @property
    def subtotal_with_tax(self) -> Price:
        return self.subtotal.with_tax()


@dataclass
class Order:
    order_id: str
    customer_id: str
    lines: list[OrderLine] = field(default_factory=list)
    status: OrderStatus = OrderStatus.PENDING
    created_at: datetime = field(default_factory=datetime.now)
    shipped_at: datetime | None = None
    delivered_at: datetime | None = None
    notes: str = ""

    @property
    def total(self) -> Price:
        if not self.lines:
            return Price(0.0)
        result = self.lines[0].subtotal_with_tax
        for line in self.lines[1:]:
            result = result + line.subtotal_with_tax
        return result

    def add_line(self, product: Product, qty: int, discount_rate: float = 0.0) -> None:
        if qty <= 0:
            raise ValueError(f"Quantity must be positive: {qty}")
        self.lines.append(OrderLine(product, qty, product.price, discount_rate))

    def can_ship(self) -> bool:
        return self.status == OrderStatus.CONFIRMED

    def ship(self) -> None:
        if not self.can_ship():
            raise ValueError(f"Order {self.order_id} is not in CONFIRMED state")
        self.status = OrderStatus.SHIPPED
        self.shipped_at = datetime.now()

    def deliver(self) -> None:
        if self.status != OrderStatus.SHIPPED:
            raise ValueError(f"Order {self.order_id} is not in SHIPPED state")
        self.status = OrderStatus.DELIVERED
        self.delivered_at = datetime.now()

    def cancel(self) -> None:
        if self.status in (OrderStatus.SHIPPED, OrderStatus.DELIVERED):
            raise ValueError(f"Cannot cancel order {self.order_id} in state {self.status}")
        self.status = OrderStatus.CANCELLED

    def to_dict(self) -> dict:
        return {
            "order_id": self.order_id,
            "customer_id": self.customer_id,
            "status": self.status.value,
            "total": self.total.amount,
            "lines": [
                {
                    "product_id": line.product.product_id,
                    "qty": line.qty,
                    "unit_price": line.unit_price.amount,
                    "discount_rate": line.discount_rate,
                    "subtotal": line.subtotal.amount,
                }
                for line in self.lines
            ],
            "created_at": self.created_at.isoformat(),
        }


# ---------------------------------------------------------------------------
# Repository / storage layer
# ---------------------------------------------------------------------------

class ProductRepository:
    def __init__(self) -> None:
        self._products: dict[str, Product] = {}

    def add(self, product: Product) -> None:
        if product.product_id in self._products:
            raise ValueError(f"Product already exists: {product.product_id}")
        self._products[product.product_id] = product

    def get(self, product_id: str) -> Product | None:
        return self._products.get(product_id)

    def get_or_raise(self, product_id: str) -> Product:
        p = self.get(product_id)
        if p is None:
            raise KeyError(f"Product not found: {product_id}")
        return p

    def remove(self, product_id: str) -> None:
        if product_id not in self._products:
            raise KeyError(f"Product not found: {product_id}")
        del self._products[product_id]

    def all(self) -> list[Product]:
        return list(self._products.values())

    def by_category(self, category: Category) -> list[Product]:
        return [p for p in self._products.values() if p.category == category]

    def needing_reorder(self) -> list[Product]:
        return [p for p in self._products.values() if p.needs_reorder()]

    def search(self, query: str) -> list[Product]:
        q = query.lower()
        return [
            p for p in self._products.values()
            if q in p.name.lower()
            or q in p.description.lower()
            or any(q in t.lower() for t in p.tags)
        ]

    def load_from_csv(self, path: str, supplier_repo: SupplierRepository) -> int:
        count = 0
        with open(path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                supplier = supplier_repo.get(row["supplier_id"])
                if supplier is None:
                    logger.warning("Unknown supplier %s, skipping %s", row["supplier_id"], row["product_id"])
                    continue
                product = Product(
                    product_id=row["product_id"],
                    name=row["name"],
                    category=Category(row["category"]),
                    price=Price(float(row["price"]), row.get("currency", "JPY")),
                    supplier=supplier,
                    stock=int(row.get("stock", 0)),
                    tags=row.get("tags", "").split("|") if row.get("tags") else [],
                )
                self.add(product)
                count += 1
        return count

    def dump_to_json(self, path: str) -> None:
        data = [p.to_dict() for p in self._products.values()]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


class SupplierRepository:
    def __init__(self) -> None:
        self._suppliers: dict[str, Supplier] = {}

    def add(self, supplier: Supplier) -> None:
        self._suppliers[supplier.supplier_id] = supplier

    def get(self, supplier_id: str) -> Supplier | None:
        return self._suppliers.get(supplier_id)

    def all(self) -> list[Supplier]:
        return list(self._suppliers.values())

    def active(self) -> list[Supplier]:
        return [s for s in self._suppliers.values() if s.active]


class OrderRepository:
    def __init__(self) -> None:
        self._orders: dict[str, Order] = {}

    def add(self, order: Order) -> None:
        if order.order_id in self._orders:
            raise ValueError(f"Order already exists: {order.order_id}")
        self._orders[order.order_id] = order

    def get(self, order_id: str) -> Order | None:
        return self._orders.get(order_id)

    def get_or_raise(self, order_id: str) -> Order:
        o = self.get(order_id)
        if o is None:
            raise KeyError(f"Order not found: {order_id}")
        return o

    def by_customer(self, customer_id: str) -> list[Order]:
        return [o for o in self._orders.values() if o.customer_id == customer_id]

    def by_status(self, status: OrderStatus) -> list[Order]:
        return [o for o in self._orders.values() if o.status == status]

    def all(self) -> list[Order]:
        return list(self._orders.values())


# ---------------------------------------------------------------------------
# Service layer
# ---------------------------------------------------------------------------

class InventoryService:
    def __init__(
        self,
        products: ProductRepository,
        orders: OrderRepository,
        suppliers: SupplierRepository,
    ) -> None:
        self.products = products
        self.orders = orders
        self.suppliers = suppliers

    def receive_stock(self, product_id: str, qty: int) -> None:
        if qty <= 0:
            raise ValueError(f"Receive qty must be positive: {qty}")
        product = self.products.get_or_raise(product_id)
        product.apply_stock_change(qty)
        logger.info("Received %d units of %s (new stock: %d)", qty, product_id, product.stock)

    def place_order(self, order_id: str, customer_id: str, items: list[dict]) -> Order:
        order = Order(order_id=order_id, customer_id=customer_id)
        for item in items:
            product = self.products.get_or_raise(item["product_id"])
            if product.status == StockStatus.DISCONTINUED:
                raise ValueError(f"Product {product.product_id} is discontinued")
            qty = item["qty"]
            if product.stock < qty:
                raise ValueError(
                    f"Insufficient stock for {product.product_id}: "
                    f"requested={qty}, available={product.stock}"
                )
            order.add_line(product, qty, item.get("discount_rate", 0.0))
        for line in order.lines:
            line.product.apply_stock_change(-line.qty)
        order.status = OrderStatus.CONFIRMED
        self.orders.add(order)
        logger.info("Order %s confirmed for customer %s (total: %s)", order_id, customer_id, order.total)
        return order

    def ship_order(self, order_id: str) -> None:
        order = self.orders.get_or_raise(order_id)
        order.ship()
        logger.info("Order %s shipped", order_id)

    def deliver_order(self, order_id: str) -> None:
        order = self.orders.get_or_raise(order_id)
        order.deliver()
        logger.info("Order %s delivered", order_id)

    def cancel_order(self, order_id: str) -> None:
        order = self.orders.get_or_raise(order_id)
        prev_status = order.status
        order.cancel()
        if prev_status == OrderStatus.CONFIRMED:
            for line in order.lines:
                line.product.apply_stock_change(line.qty)
            logger.info("Stock restored for cancelled order %s", order_id)

    def reorder_report(self) -> list[dict]:
        result = []
        for product in self.products.needing_reorder():
            if not product.supplier.is_reachable():
                logger.warning("Supplier not reachable for %s", product.product_id)
                continue
            expected = product.supplier.expected_delivery(date.today())
            result.append({
                "product_id": product.product_id,
                "name": product.name,
                "current_stock": product.stock,
                "reorder_qty": product.reorder_qty,
                "supplier": product.supplier.name,
                "expected_delivery": expected.isoformat(),
            })
        return result

    def sales_summary(self, customer_id: str | None = None) -> dict:
        orders = (
            self.orders.by_customer(customer_id)
            if customer_id
            else self.orders.all()
        )
        delivered = [o for o in orders if o.status == OrderStatus.DELIVERED]
        total_revenue = sum(o.total.amount for o in delivered)
        return {
            "total_orders": len(orders),
            "delivered": len(delivered),
            "total_revenue": total_revenue,
            "avg_order_value": total_revenue / len(delivered) if delivered else 0.0,
        }


# ---------------------------------------------------------------------------
# Report generator
# ---------------------------------------------------------------------------

class ReportGenerator:
    def __init__(self, service: InventoryService) -> None:
        self.service = service

    def stock_status_report(self) -> str:
        lines = ["=== Stock Status Report ===", f"Generated: {datetime.now().isoformat()}", ""]
        for status in StockStatus:
            products = [
                p for p in self.service.products.all()
                if p.status == status
            ]
            lines.append(f"[{status.value.upper()}] ({len(products)} items)")
            for p in products:
                lines.append(f"  {p.product_id:12s} {p.name:30s} stock={p.stock}")
            lines.append("")
        return "\n".join(lines)

    def reorder_report(self) -> str:
        items = self.service.reorder_report()
        lines = ["=== Reorder Report ===", f"Generated: {datetime.now().isoformat()}", ""]
        if not items:
            lines.append("No items need reordering.")
        else:
            for item in items:
                lines.append(
                    f"{item['product_id']:12s} {item['name']:30s} "
                    f"stock={item['current_stock']:4d} "
                    f"reorder={item['reorder_qty']:4d} "
                    f"supplier={item['supplier']} "
                    f"ETA={item['expected_delivery']}"
                )
        return "\n".join(lines)

    def sales_report(self, customer_id: str | None = None) -> str:
        summary = self.service.sales_summary(customer_id)
        header = f"=== Sales Report {'(customer: ' + customer_id + ')' if customer_id else '(all)'} ==="
        lines = [
            header,
            f"Generated: {datetime.now().isoformat()}",
            "",
            f"Total orders   : {summary['total_orders']}",
            f"Delivered      : {summary['delivered']}",
            f"Total revenue  : JPY {summary['total_revenue']:,.2f}",
            f"Avg order value: JPY {summary['avg_order_value']:,.2f}",
        ]
        return "\n".join(lines)

    def category_breakdown(self) -> str:
        lines = ["=== Category Breakdown ===", ""]
        for category in Category:
            products = self.service.products.by_category(category)
            if not products:
                continue
            total_stock = sum(p.stock for p in products)
            lines.append(f"{category.value:15s}: {len(products):4d} products, {total_stock:6d} units total")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _parse_args(args: list[str]) -> dict:
    parsed: dict = {"command": None, "options": {}}
    if not args:
        return parsed
    parsed["command"] = args[0]
    i = 1
    while i < len(args):
        if args[i].startswith("--"):
            key = args[i][2:]
            value = args[i + 1] if i + 1 < len(args) and not args[i + 1].startswith("--") else True
            parsed["options"][key] = value
            i += 2 if value is not True else 1
        else:
            i += 1
    return parsed


def _build_demo_data() -> InventoryService:
    supplier_repo = SupplierRepository()
    supplier_repo.add(Supplier("S001", "Tech Supplies Co.", "order@techsupplies.example", "03-1234-5678", "Tokyo", lead_days=5))
    supplier_repo.add(Supplier("S002", "Fashion Wholesale", "sales@fashionwhole.example", "06-9876-5432", "Osaka", lead_days=10))
    supplier_repo.add(Supplier("S003", "Food Distributors Ltd.", "info@fooddist.example", "052-111-2222", "Nagoya", lead_days=3))

    product_repo = ProductRepository()
    s1 = supplier_repo.get("S001")
    s2 = supplier_repo.get("S002")
    s3 = supplier_repo.get("S003")
    assert s1 and s2 and s3

    products = [
        Product("P001", "Wireless Keyboard", Category.ELECTRONICS, Price(4980), s1, stock=50, tags=["keyboard", "wireless"]),
        Product("P002", "USB-C Hub", Category.ELECTRONICS, Price(3280), s1, stock=8, tags=["usb", "hub"]),
        Product("P003", "Cotton T-Shirt M", Category.CLOTHING, Price(1980), s2, stock=120, tags=["cotton", "tshirt"]),
        Product("P004", "Running Shoes 26cm", Category.SPORTS, Price(8900), s2, stock=5, tags=["shoes", "running"]),
        Product("P005", "Organic Green Tea 100g", Category.FOOD, Price(850), s3, stock=200, tags=["tea", "organic"]),
        Product("P006", "Standing Desk", Category.FURNITURE, Price(39800), s1, stock=0, tags=["desk", "ergonomic"]),
        Product("P007", "Bluetooth Speaker", Category.ELECTRONICS, Price(6500), s1, stock=30, tags=["speaker", "bluetooth"]),
        Product("P008", "Yoga Mat", Category.SPORTS, Price(3200), s2, stock=3, tags=["yoga", "mat"]),
    ]
    for p in products:
        product_repo.add(p)

    order_repo = OrderRepository()
    service = InventoryService(product_repo, order_repo, supplier_repo)
    return service


def main(argv: list[str] | None = None) -> int:
    import sys
    argv = argv or sys.argv[1:]
    parsed = _parse_args(argv)
    cmd = parsed["command"]
    opts = parsed["options"]

    logging.basicConfig(level=logging.WARNING)
    service = _build_demo_data()
    reporter = ReportGenerator(service)

    if cmd == "stock":
        print(reporter.stock_status_report())
    elif cmd == "reorder":
        print(reporter.reorder_report())
    elif cmd == "sales":
        print(reporter.sales_report(opts.get("customer")))
    elif cmd == "categories":
        print(reporter.category_breakdown())
    elif cmd == "order":
        try:
            order = service.place_order(
                opts.get("id", "ORD-DEMO"),
                opts.get("customer", "C001"),
                [{"product_id": opts["product"], "qty": int(opts.get("qty", 1))}],
            )
            print(f"Order placed: {order.order_id}, total={order.total}")
        except (KeyError, ValueError) as e:
            print(f"Error: {e}")
            return 1
    else:
        print("Usage: large_1000.py <stock|reorder|sales|categories|order> [options]")
        return 1

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

class ProductValidator:
    @staticmethod
    def validate_product_id(product_id: str) -> list[str]:
        errors = []
        if not product_id:
            errors.append("product_id must not be empty")
        if not re.match(r"^[A-Z]\d{3}$", product_id):
            errors.append(f"product_id must match P### format: {product_id}")
        return errors

    @staticmethod
    def validate_price(price: Price) -> list[str]:
        errors = []
        if price.amount <= 0:
            errors.append(f"Price must be positive: {price.amount}")
        if price.amount > 10_000_000:
            errors.append(f"Price seems too high: {price.amount}")
        return errors

    @staticmethod
    def validate_product(product: Product) -> list[str]:
        errors = []
        errors.extend(ProductValidator.validate_product_id(product.product_id))
        errors.extend(ProductValidator.validate_price(product.price))
        if not product.name.strip():
            errors.append("Product name must not be empty")
        if len(product.name) > 100:
            errors.append(f"Product name too long: {len(product.name)} chars")
        if product.reorder_point < 0:
            errors.append(f"reorder_point must be non-negative: {product.reorder_point}")
        return errors


class OrderValidator:
    @staticmethod
    def validate_order_id(order_id: str) -> list[str]:
        if not order_id or len(order_id) < 4:
            return ["order_id must be at least 4 characters"]
        return []

    @staticmethod
    def validate_order(order: Order) -> list[str]:
        errors = OrderValidator.validate_order_id(order.order_id)
        if not order.customer_id:
            errors.append("customer_id must not be empty")
        if not order.lines:
            errors.append("Order must have at least one line")
        for i, line in enumerate(order.lines):
            if line.qty <= 0:
                errors.append(f"Line {i}: qty must be positive")
            if line.discount_rate < 0 or line.discount_rate > MAX_DISCOUNT_RATE:
                errors.append(f"Line {i}: discount_rate out of range")
        return errors


# ---------------------------------------------------------------------------
# Event system
# ---------------------------------------------------------------------------

class Event:
    def __init__(self, event_type: str, payload: dict) -> None:
        self.event_id = str(id(self))
        self.event_type = event_type
        self.payload = payload
        self.occurred_at = datetime.now()

    def __str__(self) -> str:
        return f"[{self.event_type}] {self.occurred_at.isoformat()} payload={self.payload}"


class EventBus:
    def __init__(self) -> None:
        self._handlers: dict[str, list] = {}
        self._history: list[Event] = []

    def subscribe(self, event_type: str, handler) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    def publish(self, event: Event) -> None:
        self._history.append(event)
        for handler in self._handlers.get(event.event_type, []):
            try:
                handler(event)
            except Exception as e:
                import sys
                print(f"Handler error for {event.event_type}: {e}", file=sys.stderr)

    def history(self, event_type: str | None = None) -> list[Event]:
        if event_type is None:
            return list(self._history)
        return [e for e in self._history if e.event_type == event_type]


# ---------------------------------------------------------------------------
# Notification service
# ---------------------------------------------------------------------------

class NotificationService:
    def __init__(self) -> None:
        self._sent: list[dict] = []

    def notify_low_stock(self, product: Product) -> None:
        msg = {
            "type": "low_stock",
            "product_id": product.product_id,
            "name": product.name,
            "stock": product.stock,
            "reorder_point": product.reorder_point,
            "sent_at": datetime.now().isoformat(),
        }
        self._sent.append(msg)
        logger.info("Low stock notification: %s (stock=%d)", product.product_id, product.stock)

    def notify_order_confirmed(self, order: Order) -> None:
        msg = {
            "type": "order_confirmed",
            "order_id": order.order_id,
            "customer_id": order.customer_id,
            "total": order.total.amount,
            "sent_at": datetime.now().isoformat(),
        }
        self._sent.append(msg)
        logger.info("Order confirmed notification: %s", order.order_id)

    def notify_order_shipped(self, order: Order) -> None:
        msg = {
            "type": "order_shipped",
            "order_id": order.order_id,
            "customer_id": order.customer_id,
            "sent_at": datetime.now().isoformat(),
        }
        self._sent.append(msg)

    def notify_reorder_needed(self, items: list[dict]) -> None:
        msg = {
            "type": "reorder_needed",
            "items": items,
            "sent_at": datetime.now().isoformat(),
        }
        self._sent.append(msg)
        logger.info("Reorder notification sent: %d items", len(items))

    def sent_history(self, notification_type: str | None = None) -> list[dict]:
        if notification_type is None:
            return list(self._sent)
        return [m for m in self._sent if m["type"] == notification_type]


# ---------------------------------------------------------------------------
# Import / export utilities
# ---------------------------------------------------------------------------

class DataExporter:
    @staticmethod
    def products_to_csv(products: list[Product], path: str) -> int:
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=[
                "product_id", "name", "category", "price", "currency",
                "stock", "status", "supplier_id", "tags", "discontinued",
            ])
            writer.writeheader()
            for p in products:
                row = p.to_dict()
                row["tags"] = "|".join(p.tags)
                writer.writerow(row)
        return len(products)

    @staticmethod
    def orders_to_json(orders: list[Order], path: str) -> int:
        data = [o.to_dict() for o in orders]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return len(orders)

    @staticmethod
    def summary_to_text(service: InventoryService, path: str) -> None:
        reporter = ReportGenerator(service)
        with open(path, "w", encoding="utf-8") as f:
            f.write(reporter.stock_status_report())
            f.write("\n\n")
            f.write(reporter.reorder_report())
            f.write("\n\n")
            f.write(reporter.category_breakdown())


class DataImporter:
    @staticmethod
    def products_from_json(path: str, supplier_repo: SupplierRepository) -> list[Product]:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        products = []
        for item in data:
            supplier = supplier_repo.get(item["supplier_id"])
            if supplier is None:
                logger.warning("Unknown supplier %s, skipping %s", item["supplier_id"], item["product_id"])
                continue
            products.append(Product(
                product_id=item["product_id"],
                name=item["name"],
                category=Category(item["category"]),
                price=Price(item["price"], item.get("currency", "JPY")),
                supplier=supplier,
                stock=item.get("stock", 0),
                tags=item.get("tags", []),
                discontinued=item.get("discontinued", False),
            ))
        return products


# ---------------------------------------------------------------------------
# Statistics helpers
# ---------------------------------------------------------------------------

def stock_statistics(products: list[Product]) -> dict:
    if not products:
        return {}
    stocks = [p.stock for p in products]
    total = sum(stocks)
    avg = total / len(stocks)
    sorted_stocks = sorted(stocks)
    mid = len(sorted_stocks) // 2
    median = sorted_stocks[mid] if len(sorted_stocks) % 2 == 1 else (sorted_stocks[mid - 1] + sorted_stocks[mid]) / 2
    return {
        "count": len(products),
        "total_stock": total,
        "avg_stock": round(avg, 1),
        "median_stock": median,
        "min_stock": min(stocks),
        "max_stock": max(stocks),
        "out_of_stock": sum(1 for p in products if p.stock == 0),
        "low_stock": sum(1 for p in products if 0 < p.stock <= p.reorder_point),
    }


def revenue_by_category(orders: list[Order]) -> dict[str, float]:
    result: dict[str, float] = {}
    for order in orders:
        if order.status != OrderStatus.DELIVERED:
            continue
        for line in order.lines:
            cat = line.product.category.value
            result[cat] = result.get(cat, 0.0) + line.subtotal.amount
    return result


def top_selling_products(orders: list[Order], n: int = 10) -> list[dict]:
    qty_map: dict[str, int] = {}
    name_map: dict[str, str] = {}
    for order in orders:
        if order.status != OrderStatus.DELIVERED:
            continue
        for line in order.lines:
            pid = line.product.product_id
            qty_map[pid] = qty_map.get(pid, 0) + line.qty
            name_map[pid] = line.product.name
    ranked = sorted(qty_map.items(), key=lambda x: x[1], reverse=True)[:n]
    return [{"product_id": pid, "name": name_map[pid], "total_qty": qty} for pid, qty in ranked]


def customer_order_stats(orders: list[Order]) -> dict[str, dict]:
    stats: dict[str, dict] = {}
    for order in orders:
        cid = order.customer_id
        if cid not in stats:
            stats[cid] = {"total_orders": 0, "total_spent": 0.0, "statuses": {}}
        stats[cid]["total_orders"] += 1
        if order.status == OrderStatus.DELIVERED:
            stats[cid]["total_spent"] += order.total.amount
        s = order.status.value
        stats[cid]["statuses"][s] = stats[cid]["statuses"].get(s, 0) + 1
    return stats


# ---------------------------------------------------------------------------
# Discount engine
# ---------------------------------------------------------------------------

class DiscountRule:
    def __init__(self, name: str, condition, rate: float) -> None:
        self.name = name
        self.condition = condition  # callable(product, qty) -> bool
        self.rate = rate

    def applies(self, product: Product, qty: int) -> bool:
        return self.condition(product, qty)


class DiscountEngine:
    def __init__(self) -> None:
        self._rules: list[DiscountRule] = []

    def add_rule(self, rule: DiscountRule) -> None:
        self._rules.append(rule)

    def best_discount(self, product: Product, qty: int) -> float:
        applicable = [r.rate for r in self._rules if r.applies(product, qty)]
        return max(applicable) if applicable else 0.0

    def all_applicable(self, product: Product, qty: int) -> list[DiscountRule]:
        return [r for r in self._rules if r.applies(product, qty)]


def build_default_discount_engine() -> DiscountEngine:
    engine = DiscountEngine()
    engine.add_rule(DiscountRule(
        "bulk_10",
        lambda p, q: q >= 10,
        0.05,
    ))
    engine.add_rule(DiscountRule(
        "bulk_50",
        lambda p, q: q >= 50,
        0.10,
    ))
    engine.add_rule(DiscountRule(
        "electronics_promo",
        lambda p, q: p.category == Category.ELECTRONICS,
        0.03,
    ))
    engine.add_rule(DiscountRule(
        "clothing_season",
        lambda p, q: p.category == Category.CLOTHING and q >= 5,
        0.15,
    ))
    return engine


# ---------------------------------------------------------------------------
# Pagination helper
# ---------------------------------------------------------------------------

def paginate(items: list, page: int, page_size: int) -> dict:
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": (total + page_size - 1) // page_size,
        "items": items[start:end],
    }


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

def system_health_check(service: InventoryService) -> dict:
    products = service.products.all()
    orders = service.orders.all()
    return {
        "status": "ok",
        "product_count": len(products),
        "order_count": len(orders),
        "out_of_stock_count": sum(1 for p in products if p.stock == 0),
        "pending_orders": len(service.orders.by_status(OrderStatus.PENDING)),
        "confirmed_orders": len(service.orders.by_status(OrderStatus.CONFIRMED)),
        "reorder_needed": len(service.products.needing_reorder()),
        "checked_at": datetime.now().isoformat(),
    }
