---
source_file: single_file/algorithms.py
---

# ファイル: algorithms.py
## 目的
ai-code-guide の動作確認用サンプル。再帰・DP・BFS など性質の違うアルゴリズムを1ファイルに収録し、フローチャートの粒度切り替えとインライン解説のテスト対象にする。 <!-- @inferred -->

## 関数: quicksort
### 目的
整数リストを昇順に並べ替える。 <!-- @inferred -->
### 要件・制約
- 元のリストを破壊しない（新しいリストを返す） <!-- @inferred -->
### 方針
先頭要素を pivot にした再帰実装。リスト内包表記で小さい側/大きい側に分けて結合する。 <!-- @inferred -->
### 構成
1. 再帰の底（長さ1以下） → anchor: "if len(arr) <= 1:"
2. pivot で2分割 → anchor: "less = [x for x in arr[1:] if x <= pivot]"
3. 再帰結果の結合 → anchor: "return quicksort(less) + [pivot] + quicksort(greater)"

## 関数: mergesort
### 目的
整数リストを昇順に並べ替える（マージソート）。 <!-- @inferred -->
### 方針
半分に分割して各々を再帰ソートし、_merge で結合する設計。現状の実装は分割処理が欠けており未定義変数を参照する（AI解説がバグを検出できるかのテスト用に意図的に壊してある）。 <!-- @inferred -->
### 構成
1. 再帰の底 → anchor: "if len(arr) <= 1:"
2. マージへ委譲 → anchor: "return _merge(left, right)"

## 関数: _merge
### 目的
2つのソート済みリストを1つのソート済みリストに結合する。 <!-- @inferred -->
### 方針
先頭同士を比較して小さい方を取り出す2ポインタ走査。残りは末尾にまとめて足す。 <!-- @inferred -->
### 構成
1. 2ポインタ比較 → anchor: "while i < len(left) and j < len(right):"
2. 残りの吸収 → anchor: "result.extend(left[i:])"

## 関数: knapsack
### 目的
0/1ナップサック問題の最大価値を求める。 <!-- @inferred -->
### 要件・制約
- 各品物は1回しか選べない（0/1） <!-- @inferred -->
### 方針
2次元DPテーブル dp[品物数+1][容量+1] を埋めるボトムアップ実装。 <!-- @inferred -->
### 構成
1. テーブル初期化 → anchor: "dp = [[0] * (capacity + 1) for _ in range(n + 1)]"
2. 入らない場合は据え置き → anchor: "if weights[i - 1] > w:"
3. 入れる/入れないの最大化 → anchor: "dp[i][w] = max("

## 関数: longest_common_subsequence
### 目的
2つの文字列の最長共通部分列の長さを求める。 <!-- @inferred -->
### 方針
2次元DP。文字が一致したら左上+1、不一致なら上と左の大きい方。 <!-- @inferred -->
### 構成
1. 一致時の遷移 → anchor: "dp[i][j] = dp[i - 1][j - 1] + 1"
2. 不一致時の遷移 → anchor: "dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])"

## 関数: bfs_shortest_path
### 目的
グラフ上で start から goal への最短経路を1本返す。到達不能なら None。 <!-- @inferred -->
### 要件・制約
- 辺の重みなし（ホップ数最短） <!-- @inferred -->
### 方針
経路そのものをキューに積むBFS。訪問済み集合で再訪を防ぎ、goal に届いた経路を即返す。 <!-- @inferred -->
### 構成
1. 自明ケース（start==goal） → anchor: "if start == goal:"
2. 経路キューの走査 → anchor: "path = queue.popleft()"
3. ゴール到達で即返す → anchor: "if neighbor == goal:"

## 関数: has_cycle
### 目的
有向グラフにサイクルがあるかを判定する。 <!-- @inferred -->
### 方針
DFS中の経路上ノード集合（on_stack）を持ち、経路上のノードへ戻ったらサイクルと判定する。 <!-- @inferred -->
### 構成
1. 経路上集合への出入り → anchor: "on_stack.add(node)"
2. 後退辺の検出 → anchor: "elif neighbor in on_stack:"
3. 全ノードから起動 → anchor: "return any(dfs(n) for n in graph if n not in visited)"

## 関数: longest_palindrome
### 目的
文字列中の最長回文部分文字列を返す。 <!-- @inferred -->
### 方針
各位置を中心に左右へ広げる中心拡張法。奇数長・偶数長の2通りを試す。 <!-- @inferred -->
### 構成
1. 中心からの拡張 → anchor: "while left >= 0 and right < len(s) and s[left] == s[right]:"
2. 奇数長・偶数長の両起点 → anchor: "expand(i, i)"
