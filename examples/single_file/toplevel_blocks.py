"""トップレベルブロックの行数グラデーション確認用。

処理ブロックを1〜6行の階段状に並べ、1行ごとに濃さが変わること、
5行で完全に濃くなり以降は頭打ちになることを見る。
"""

import os

S1 = os.getcwd()

S2 = [
    1, 2]

S3 = [
    1,
    2]

S4 = {
    "a": 1,
    "b": 2,
}

S5 = [
    1,
    2,
    3,
    4]

S6 = [
    1,
    2,
    3,
    4,
    5]


def use_them() -> int:
    return len(S1) + len(S2) + len(S3) + len(S4) + len(S5) + len(S6)


if __name__ == "__main__":
    print(use_them())
