"""例外処理フローのテスト。try/except/else/finally と再raise を組み合わせる。"""

import json
import os
from typing import Any


class ConfigError(Exception):
    pass


class NetworkError(Exception):
    pass


def load_config(path: str) -> dict[str, Any]:
    """設定ファイルを読み込む。ファイルなし・JSON不正・必須キー欠落を区別して報告する。"""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise ConfigError(f"config not found: {path}")
    except json.JSONDecodeError as e:
        raise ConfigError(f"invalid JSON: {e}")
    else:
        required = {"host", "port", "token"}
        missing = required - set(data.keys())
        if missing:
            raise ConfigError(f"missing keys: {missing}")
        return data


def fetch_with_retry(url: str, max_retries: int = 3) -> str:
    """URL からデータを取得する。失敗時は max_retries 回までリトライする。"""
    last_error: Exception = NetworkError("no attempt made")
    for attempt in range(1, max_retries + 1):
        try:
            # 実際のHTTP呼び出しの代わりにファイル読み込みで模倣
            with open(url, encoding="utf-8") as f:
                return f.read()
        except FileNotFoundError as e:
            last_error = NetworkError(f"not found: {e}")
            break
        except OSError as e:
            last_error = NetworkError(f"attempt {attempt} failed: {e}")
            if attempt == max_retries:
                raise last_error
    raise last_error


def process_pipeline(config_path: str, data_path: str) -> dict[str, Any]:
    """設定読み込み→データ取得→パースの一連処理。各ステップの失敗を個別にハンドルする。"""
    result: dict[str, Any] = {"status": "unknown"}
    try:
        config = load_config(config_path)
        result["config_host"] = config["host"]
    except ConfigError as e:
        result["status"] = "config_error"
        result["error"] = str(e)
        return result

    try:
        raw = fetch_with_retry(data_path)
    except NetworkError as e:
        result["status"] = "fetch_error"
        result["error"] = str(e)
        return result
    finally:
        # 成否に関わらず一時ファイルを削除
        tmp = data_path + ".tmp"
        if os.path.exists(tmp):
            os.remove(tmp)

    try:
        parsed = json.loads(raw)
        result["status"] = "ok"
        result["data"] = parsed
    except json.JSONDecodeError:
        result["status"] = "parse_error"
        result["error"] = "response is not valid JSON"

    return result


if __name__ == "__main__":
    r = process_pipeline("config.json", "data.json")
    print(r)
