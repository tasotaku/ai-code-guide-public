"""複雑なループ制御のテスト。break/continue/for-else/while を組み合わせる。"""

from typing import Optional


def find_first_duplicate(nums: list[int]) -> Optional[int]:
    """リストの中で最初に2回目が出現する値を返す。なければ None。"""
    seen: set[int] = set()
    for n in nums:
        if n in seen:
            return n
        seen.add(n)
    return None


def compress_runs(data: list[int]) -> list[tuple[int, int]]:
    """連続する同じ値をまとめて (値, 個数) のリストにする。"""
    if not data:
        return []

    result: list[tuple[int, int]] = []
    i = 0
    while i < len(data):
        val = data[i]
        count = 1
        while i + count < len(data) and data[i + count] == val:
            count += 1
        result.append((val, count))
        i += count
    return result


def find_subarray_sum(nums: list[int], target: int) -> tuple[int, int]:
    """合計が target になる連続部分列の (start, end) を返す。なければ (-1, -1)。"""
    left = 0
    current = 0
    for right in range(len(nums)):
        current += nums[right]
        while current > target and left <= right:
            current -= nums[left]
            left += 1
        if current == target:
            return (left, right)
    return (-1, -1)


def matrix_spiral(matrix: list[list[int]]) -> list[int]:
    """行列を螺旋順に読んで1次元リストで返す。"""
    if not matrix:
        return []

    result: list[int] = []
    top, bottom, left, right = 0, len(matrix) - 1, 0, len(matrix[0]) - 1

    while top <= bottom and left <= right:
        for col in range(left, right + 1):
            result.append(matrix[top][col])
        top += 1

        for row in range(top, bottom + 1):
            result.append(matrix[row][right])
        right -= 1

        if top <= bottom:
            for col in range(right, left - 1, -1):
                result.append(matrix[bottom][col])
            bottom -= 1

        if left <= right:
            for row in range(bottom, top - 1, -1):
                result.append(matrix[row][left])
            left += 1

    return result


def next_prime(n: int) -> int:
    """n より大きい最小の素数を返す。"""
    candidate = n + 1
    while True:
        if candidate < 2:
            candidate += 1
            continue
        for divisor in range(2, int(candidate**0.5) + 1):
            if candidate % divisor == 0:
                break
        else:
            return candidate
        candidate += 1


if __name__ == "__main__":
    print(find_first_duplicate([1, 3, 2, 3, 5]))
    print(compress_runs([1, 1, 2, 3, 3, 3, 1]))
    print(find_subarray_sum([1, 2, 3, 4, 5], 9))
    print(matrix_spiral([[1, 2, 3], [4, 5, 6], [7, 8, 9]]))
    print(next_prime(10))
