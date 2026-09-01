"""レスポンス整形・表示フォーマット関数群。"""

import datetime
from typing import Any


def format_response(status: int, data: Any = None, error: str = "") -> dict:
    """統一レスポンス形式を返す。"""
    if error:
        return {"status": status, "body": {"error": error}}
    return {"status": status, "body": data}


def format_price(price: float, currency: str = "JPY") -> str:
    """価格を通貨付き文字列にフォーマットする。"""
    if currency == "JPY":
        return f"¥{int(price):,}"
    return f"{price:.2f} {currency}"


def format_datetime(dt: datetime.datetime) -> str:
    """datetimeをISO 8601形式の文字列にフォーマットする。"""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
