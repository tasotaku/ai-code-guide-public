# FC テストケース一覧

FCの品質検証用サンプルファイル。各ファイルが何を確認するためのものかをまとめる。

---

## deep_conditionals.py

### 内容
- `check_access()` : ロール・リソース・オーナー・BANフラグ・サブスク状態の組み合わせでアクセス可否を返す（if 4〜5段ネスト）
- `classify_score()` : スコア・試行回数・時間の3軸でランクを決定する（elif連鎖 + ネスト）

### FCで確認すること
- 深いネストがグラフとして読めるか（ノードが多すぎて追えなくなっていないか）
- elif チェーンが縦に並ぶか、横に広がるか
- 各分岐の末端 return がどう表現されるか

---

## loop_patterns.py

### 内容
- `find_first_duplicate()` : seen セットで最初の重複を見つける（for + 早期 return）
- `compress_runs()` : 連続する同値をカウントしてまとめる（while + 内側 while）
- `find_subarray_sum()` : スライディングウィンドウで合計が target の部分列を探す（for + while + break条件）
- `matrix_spiral()` : 行列を螺旋状に読む（while + 4方向 for ループ）
- `next_prime()` : n より大きい最小の素数を返す（while True + for-else + continue）

### FCで確認すること
- break / continue が分岐として正しく表現されるか
- for-else（`next_prime` の素数判定）が見えるか
- 二重ループ（`compress_runs`）のネスト構造が追えるか
- while True の無限ループがどう描画されるか

---

## exception_flow.py

### 内容
- `load_config()` : ファイル読み込み → JSON デコード → 必須キー検証。3種の失敗を区別して raise
- `fetch_with_retry()` : リトライ付き取得。FileNotFoundError は即 break、OSError は max_retries 回まで継続
- `process_pipeline()` : 上2つを呼び出し、各ステップの失敗を個別にハンドル。finally でクリーンアップ

### FCで確認すること
- try/except の各ブランチが別ノードとして見えるか
- try/except/else（`load_config` の必須キーチェックは else 節に相当）の構造
- finally ブロックがどこに配置されるか
- 複数 except を持つ場合の分岐の見え方

---

## algorithms.py

### 内容
関数8本。粒度切り替えや「特定関数だけ detail で見る」操作の対象として設計。

| 関数 | 種別 |
|---|---|
| `quicksort()` | 再帰ソート（pivot で left/right に分けて再帰） |
| `mergesort()` | 再帰ソート（半分に分けてマージ） |
| `_merge()` | mergesort のヘルパー（2リストのマージ） |
| `knapsack()` | DP（二重ループで dp テーブルを埋める） |
| `longest_common_subsequence()` | DP（文字一致/不一致で2択） |
| `bfs_shortest_path()` | BFS（キューと visited で最短経路） |
| `has_cycle()` | DFS（on_stack で閉路検出、内部に nested def） |
| `longest_palindrome()` | 中心展開法（expand を奇数・偶数の2回呼ぶ） |

### FCで確認すること
- coarse モードで8関数がどう省略されるか
- 再帰呼び出し（`quicksort`, `mergesort`）がグラフ上でどう表現されるか
- nested def（`has_cycle` 内の `dfs`）が扱われるか、無視されるか
- DP の二重ループ（`knapsack`）が detail モードでどこまで展開されるか
- 関数名を指定して1関数だけ表示する操作の動作確認
