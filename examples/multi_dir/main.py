"""エントリポイント。登録→ログイン→商品閲覧→注文のシナリオを実行する。"""

from api import auth_api, shop_api


def run_scenario() -> None:
    """一連のユーザーシナリオを実行して動作を確認する。"""
    # ユーザー登録
    res = auth_api.handle_register({
        "email": "bob@example.com",
        "password": "secret123",
        "name": "Bob",
    })
    print(f"register: {res}")

    # ログイン
    res = auth_api.handle_login({
        "email": "bob@example.com",
        "password": "secret123",
    })
    print(f"login: {res}")
    token = res["body"].get("token", "") if res["status"] == 200 else ""

    # 商品一覧
    res = shop_api.handle_list_products(headers={})
    print(f"products: {res}")

    # 注文
    headers = {"Authorization": f"Bearer {token}"}
    res = shop_api.handle_place_order(
        body={"items": [
            {"product_id": "p001", "quantity": 2},
            {"product_id": "p003", "quantity": 1},
        ]},
        headers=headers,
    )
    print(f"order: {res}")

    # 注文キャンセル
    if res["status"] == 201:
        order_id = res["body"]["order_id"]
        res = shop_api.handle_cancel_order(order_id, headers=headers)
        print(f"cancel: {res}")


if __name__ == "__main__":
    run_scenario()
