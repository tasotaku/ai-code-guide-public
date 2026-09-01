"""複数アルゴリズムのテスト。再帰・DP・BFS を1ファイルに収録し粒度切り替えの対象にする。"""

from collections import deque
from typing import Optional


# ── ソート ──────────────────────────────────────────────────────────────────

def quicksort(arr: list[int]) -> list[int]:
    """クイックソート（再帰）。pivot は先頭要素。"""
    if len(arr) <= 1:
        return arr
    pivot = arr[0]
    less = [x for x in arr[1:] if x <= pivot]
    greater = [x for x in arr[1:] if x > pivot]
    return quicksort(less) + [pivot] + quicksort(greater)


def mergesort(arr: list[int]) -> list[int]:
    """マージソート（再帰）。"""
    if len(arr) <= 1:
        return arr

    return _merge(left, right)


def _merge(left: list[int], right: list[int]) -> list[int]:
    """2つのソート済みリストをマージする。"""
    result: list[int] = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    result.extend(left[i:])
    result.extend(right[j:])
    return result


# ── 動的計画法 ────────────────────────────────────────────────────────────────

def knapsack(weights: list[int], values: list[int], capacity: int) -> int:
    """0/1 ナップサック問題。最大価値を返す。"""
    n = len(weights)
    dp = [[0] * (capacity + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for w in range(capacity + 1):
            if weights[i - 1] > w:
                dp[i][w] = dp[i - 1][w]
            else:
                dp[i][w] = max(
                    dp[i - 1][w],
                    dp[i - 1][w - weights[i - 1]] + values[i - 1],
                )
    return dp[n][capacity]


def longest_common_subsequence(s1: str, s2: str) -> int:
    """最長共通部分列の長さを返す。"""
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if s1[i - 1] == s2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    return dp[m][n]


# ── グラフ探索 ────────────────────────────────────────────────────────────────

Graph = dict[str, list[str]]


def bfs_shortest_path(graph: Graph, start: str, goal: str) -> Optional[list[str]]:
    """BFS で start から goal への最短経路を返す。到達不能なら None。"""
    if start == goal:
        return [start]
    visited = {start}
    queue: deque[list[str]] = deque([[start]])
    while queue:
        path = queue.popleft()
        node = path[-1]
        for neighbor in graph.get(node, []):
            if neighbor in visited:
                continue
            new_path = path + [neighbor]
            if neighbor == goal:
                return new_path
            visited.add(neighbor)
            queue.append(new_path)
    return None


def has_cycle(graph: Graph) -> bool:
    """有向グラフにサイクルが存在するか DFS で判定する。"""
    visited: set[str] = set()
    on_stack: set[str] = set()

    def dfs(node: str) -> bool:
        visited.add(node)
        on_stack.add(node)
        for neighbor in graph.get(node, []):
            if neighbor not in visited:
                if dfs(neighbor):
                    return True
            elif neighbor in on_stack:
                return True
        on_stack.discard(node)
        return False

    return any(dfs(n) for n in graph if n not in visited)


# ── 文字列 ────────────────────────────────────────────────────────────────────

def longest_palindrome(s: str) -> str:
    """文字列中の最長回文部分列を返す（Manacher 法の簡易版）。"""
    if not s:
        return ""
    best_start = best_len = 0

    def expand(left: int, right: int) -> None:
        nonlocal best_start, best_len
        while left >= 0 and right < len(s) and s[left] == s[right]:
            left -= 1
            right += 1
        length = right - left - 1
        if length > best_len:
            best_len = length
            best_start = left + 1

    for i in range(len(s)):
        expand(i, i)       # 奇数長
        expand(i, i + 1)   # 偶数長

    return s[best_start: best_start + best_len]


if __name__ == "__main__":
    print(quicksort([3, 1, 4, 1, 5, 9, 2, 6]))
    print(mergesort([5, 3, 8, 1, 9, 2]))
    print(knapsack([2, 3, 4, 5], [3, 4, 5, 6], 8))
    print(longest_common_subsequence("ABCBDAB", "BDCAB"))

    g: Graph = {"A": ["B", "C"], "B": ["D"], "C": ["D"], "D": []}
    print(bfs_shortest_path(g, "A", "D"))
    print(has_cycle({"A": ["B"], "B": ["C"], "C": ["A"]}))
    print(longest_palindrome("babad"))
