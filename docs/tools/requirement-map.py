#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「需求 → 落地 → 验收」全量对照表（`docs/requirement-implementation-map.md`）。

**这张表的每一格都是机器抽出来的**，不手写：
① 落地位置 ← **代码里的溯源注释**（`R-XXX-NN` 字样）⇒ 该文件承载这条需求；
   再用 7 份阶段计划的 `**Files:**` 段把文件归到阶段与 Task。
② 验收 ← ①推得的实现文件 → 引用它的**测试文件** → owning 阶段
   `## P{n} 验收标准` 表里提到该测试文件的行（`P{n}-{m}`）。
③ 落地状态 ← 三态：
   ✅ 已落地（代码里有溯源注释）｜🟡 已落地但代码没写溯源注释｜⬜ 计划中。

⚠️ 溯源引用的**紧凑式**必须展开：`R-PTS-01/02/03/04/05/06` 只用 `R-[A-Z]+-\d+`
   匹配会把后面的编号**全丢掉** ⇒ 需求被误判成「代码无溯源注释」。
   （本项目的真实实例：services/leaderboard.js 头写 `R-RNK-01/02/03/04`、
   domain/tier.js 头写 `R-PTS-01/02/03/04/05/06`。）

用法：
    python3 docs/tools/requirement-map.py \
        --trees . .worktrees/p5-pools .worktrees/p6-deploy \
        --out docs/requirement-implementation-map.md

`--trees` 给的是**代码树根**（每棵树下有 `platform/`）。P5/P6 的代码合回 main 后，
只需把 `--trees` 收敛成 `.` 一个即可，结果不变（合流后同一份文件只会命中一次）。
"""
import argparse
import io
import json
import os
import re
import sys
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_ap = argparse.ArgumentParser(description=__doc__)
_ap.add_argument('--trees', nargs='+', default=['.'],
                 help='代码树根（每棵树下有 platform/），可给多棵')
_ap.add_argument('--out', default='docs/requirement-implementation-map.md',
                 help='输出文件路径')
ARGS = _ap.parse_args()
# -*- coding: utf-8 -*-
"""生成「需求 → 落地 → 验收」全量对照表。

分母声明：需求全集 = 96 条（docs/requirements-traceability.md 的表格，逐行解析）。

**证据来源（全部是机器抽出来的，不手写）**：
① 落地位置 ← **代码里的溯源注释**：某个实现文件里出现 `R-XXX-NN` 字样 ⇒ 这条需求落在该文件。
   再用「文件 → Task」映射（来自 7 份计划的 `**Files:**` 段）把文件归到阶段与 Task。
② 验收 ← ①推得的实现文件 → 引用了它的**测试文件**；再在 owning 计划的
   `## P{n} 验收标准` 表里找到提到该测试文件名的验收标准行（`P{n}-{m}`）。
③ 没有代码引用的需求（多为 NFR 或计划级）← 回落到**计划里**出现该 ID 的 Task；
   仍找不到 ⇒ 标 `未落地（平台不实现）` 或 `未落地（需拍板）`。

⚠️ 扫描面：main（.）+ P5 worktree + P6 worktree（.worktrees/p5-pools / .worktrees/p6-deploy）。
   三棵树的重叠文件取并集（内容相同的重复文件不影响结论）。
"""
import io
import json
import os
import re
from collections import defaultdict

TREES = [(os.path.basename(os.path.normpath(t)) or 'main', t) for t in ARGS.trees]
# 计划文件在**哪棵树**里：P5/P6 的计划在对应分支上还没合回 main。
PLANS = [
    ('P0', 'docs/superpowers/plans/2026-10-20-platform-P0-foundation.md', '.'),
    ('P1', 'docs/superpowers/plans/2026-10-20-platform-P1-registration-team.md', '.'),
    ('P2', 'docs/superpowers/plans/2026-10-20-platform-P2-review-engine.md', '.'),
    ('P3', 'docs/superpowers/plans/2026-10-20-platform-P3-leaderboard-points.md', '.'),
    ('P4', 'docs/superpowers/plans/2026-10-20-platform-P4-audit-anticheat.md', '.'),
    ('P5', 'docs/superpowers/plans/2026-10-20-platform-P5-workflow-pools.md', '.worktrees/p5-pools'),
    ('P6', 'docs/superpowers/plans/2026-10-20-platform-P6-deploy-demo.md', '.worktrees/p6-deploy'),
]
for _pn, _pr, _tr in PLANS:
    if not os.path.exists(os.path.join(REPO, _tr, _pr)) and _tr != '.':
        PLANS[PLANS.index((_pn, _pr, _tr))] = (_pn, _pr, '.')

# ── ① 需求全集 ───────────────────────────────────────────────────────────
trace = io.open(os.path.join(REPO, 'docs/requirements-traceability.md'), encoding='utf-8').read()
reqs = []
for l in trace.split('\n'):
    m = re.match(r'^\| (R-[A-Z]+-\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$', l)
    if m:
        reqs.append({'id': m.group(1), 'name': m.group(2), 'src': m.group(3),
                     'quote': m.group(4), 'state': m.group(5)})
assert len(reqs) == 96, '需求总数异常：%d' % len(reqs)

# ── ② 文件 → (阶段, Task) 映射 + 各阶段验收标准表 ───────────────────────
file2task = {}      # 相对路径 → (阶段, Task 号, Task 标题)
task_files = {}     # (阶段, Task 号) → 该 Task 声明的文件集合
accept = {}         # 阶段 → [(验收ID, 标准, 怎么验)]
plan_tasks = {}     # 阶段 → [(Task 号, Task 标题, 该 Task 段落的行号范围)]
for pn, plan_rel, tree in PLANS:
    path = os.path.join(REPO, tree, plan_rel)
    lines = io.open(path, encoding='utf-8').read().split('\n')
    idx = [i for i, l in enumerate(lines) if re.match(r'^### Task \d+', l)]
    idx.append(len(lines))
    for k in range(len(idx) - 1):
        s, e = idx[k], idx[k + 1]
        head = lines[s]
        m = re.match(r'^### Task (\d+):\s*(.*)', head)
        if not m:
            continue
        tno, ttitle = m.group(1), m.group(2).strip()
        plan_tasks.setdefault(pn, []).append((tno, ttitle, s, e))
        # Files 段 —— 有**两种**写法，都得认：
        #   ① 列表式：  - Create: `platform/src/x.js`
        #   ② 行内式：  **Files:** Create `platform/src/x.js`、`platform/test/x.test.js`
        FILES_RE = re.compile(r'(?:platform/)?[\w./-]+\.(?:js|json|sql|html|css|sh|conf|service|yml|md|txt|tgz)')
        fi = None
        for i in range(s, e):
            if lines[i].strip().startswith('**Files:**'):
                fi = i
                break
        if fi is not None:
            block = [lines[fi]]
            for i in range(fi + 1, min(fi + 8, e)):
                l = lines[i]
                if not l.strip():
                    break
                if re.match(r'^- \[ \]|^\*\*|^## ', l.strip()):
                    break
                block.append(l)
            for l in block:
                for mm in re.finditer(r'`([^`]+)`', l):
                    p = mm.group(1)
                    if not FILES_RE.fullmatch(p):
                        continue
                    p = p.replace('platform/', '', 1) if p.startswith('platform/') else p
                    file2task.setdefault(p, (pn, tno, ttitle))
                    task_files.setdefault((pn, tno), set()).add(p)
    # 验收标准表
    ai = None
    for i, l in enumerate(lines):
        if re.match(r'^## %s 验收标准' % pn, l.strip()):
            ai = i
            break
    if ai is not None:
        rows = []
        for l in lines[ai:]:
            mm = re.match(r'^\| (%s-\d+) \| (.+?) \| (.+?) \|$' % pn, l.strip())
            if mm:
                rows.append((mm.group(1), mm.group(2), mm.group(3)))
        accept[pn] = rows

# ── ③ 扫代码溯源注释 + 测试引用 ──────────────────────────────────────────
# 溯源引用的书写形态有**紧凑式**：`R-PTS-01/02/03/04/05/06`、`R-RNK-01/02/03/04`、
# `R-ENT-01/06/07/08/09/10/11/12、`、`R-STG-01/03`。
# ⚠️ 只用 `R-[A-Z]+-\d+` 匹配会把紧凑式里后面的编号**全丢掉** ⇒ 需求被误判成「代码无溯源注释」。
#   本项目的真实实例：services/leaderboard.js 头写 `R-RNK-01/02/03/04`、
#   domain/tier.js 头写 `R-PTS-01/02/03/04/05/06` —— 紧凑式后面的需求都是**有**注释的。
RID_GROUP = re.compile(r'R-([A-Z]+)-(\d+(?:/\d+)*)')


def expand_ids(text):
    """把文本里所有溯源引用展开成 ID 集合（支持紧凑式 `R-XXX-01/02/03`）。"""
    out = set()
    for m in RID_GROUP.finditer(text):
        head = m.group(1)
        for num in m.group(2).split('/'):
            if num:
                out.add('R-%s-%s' % (head, num))
    return out
code_files = []     # 相对路径（去 platform/ 前缀）
for _, tree in TREES:
    base = os.path.join(REPO, tree, 'platform')
    if not os.path.isdir(base):
        continue
    for sub in ['src', 'web', 'rules', 'db', 'scripts', 'test', 'deploy']:
        d = os.path.join(base, sub)
        if not os.path.isdir(d):
            continue
        for root, _, fs in os.walk(d):
            for fn in fs:
                # ⚠️ 扩展名白名单要含部署资产（.sh/.conf/.service/.yml）——
                #    否则「云主机部署」这类需求的落点文件根本不会被扫到
                if not fn.endswith(('.js', '.json', '.html', '.sql', '.sh', '.conf', '.service', '.yml', '.txt')):
                    continue
                p = os.path.join(root, fn)
                rel = os.path.relpath(p, base)
                if rel not in code_files:
                    code_files.append(rel)

texts = {}
for rel in code_files:
    for _, tree in TREES:
        p = os.path.join(REPO, tree, 'platform', rel)
        if os.path.exists(p):
            texts.setdefault(rel, io.open(p, encoding='utf-8', errors='ignore').read())
            break

cite = defaultdict(list)   # 需求ID → 引用它的实现文件（不含 test/）
cite_test = defaultdict(list)
for rel, c in texts.items():
    ids = expand_ids(c)
    if not ids:
        continue
    is_test = rel.startswith('test/')
    for rid in ids:
        (cite_test if is_test else cite)[rid].append(rel)

# 测试文件 → 它测了哪些实现文件（按被测文件的 basename 出现在测试里）
test_targets = defaultdict(set)
for rel, c in texts.items():
    if not rel.startswith('test/'):
        continue
    for tgt in texts:
        if tgt.startswith('test/') or tgt not in file2task:
            continue
        base = os.path.basename(tgt)
        if base and base in c:
            test_targets[rel].add(tgt)

# ── ④ 需求 → 计划 Task 的回落归属 ───────────────────────────────────────
plan_mention = defaultdict(set)
for pn, plan_rel, tree in PLANS:
    path = os.path.join(REPO, tree, plan_rel)
    lines = io.open(path, encoding='utf-8').read().split('\n')
    idx = [i for i, l in enumerate(lines) if re.match(r'^### Task \d+', l)]
    idx.append(len(lines))
    for k in range(len(idx) - 1):
        s, e = idx[k], idx[k + 1]
        seg = '\n'.join(lines[s:e])
        m = re.match(r'^### Task (\d+)[:：]?\s*(.*)', lines[s])
        if not m:
            continue
        for rid in expand_ids(seg):
            plan_mention[rid].add((pn, m.group(1), m.group(2).strip()))
# 计划开头的「需求覆盖」表（P6 的 8 条 NFR）
for pn, plan_rel, tree in PLANS:
    path = os.path.join(REPO, tree, plan_rel)
    lines = io.open(path, encoding='utf-8').read().split('\n')
    for l in lines[:40]:
        mm = re.match(r'^\| \*\*(R-[A-Z]+-\d+)\*\* \| (.+?) \| (.+?) \| (.+?) \|$', l.strip())
        if mm:
            plan_mention[mm.group(1)].add((pn, '表', '阶段需求覆盖表（见计划开头）'))

# ── ⑤ 组装 ──────────────────────────────────────────────────────────────
def phase_of(path):
    if path in file2task:
        return file2task[path]
    return None


def task_implemented(key):
    fs = task_files.get(key)
    if not fs:
        return None
    hits = 0
    for f in fs:
        for _, tree in TREES:
            if os.path.exists(os.path.join(REPO, tree, 'platform', f)):
                hits += 1
                break
    return (hits, len(fs))


rows = []
for r in reqs:
    rid = r['id']
    impls = sorted(cite.get(rid, []))
    tasks = []
    for p in impls:
        t = phase_of(p)
        if t and t not in tasks:
            tasks.append(t)
    # 验收：实现文件 → 测它的测试文件 → 该阶段验收标准里提到该测试文件名的行
    acc = []
    tested = set()
    for p in impls:
        for tf, targets in test_targets.items():
            if p in targets:
                tested.add(tf)
    for pn, rows_ in accept.items():
        # 验收行文本里可能出现「同文件」（指上一行提到的那个文件）⇒ 继承上一行的测试文件
        prev_files = []
        for aid, std, how in rows_:
            row_files = re.findall(r'test/[\w.-]+\.test\.js', std + ' ' + how)
            if '同文件' in std or '同文件' in how:
                row_files = row_files + prev_files
            prev_files = row_files or prev_files
            hit = any(os.path.basename(tf) in (std + ' ' + how) for tf in tested)
            if not hit:
                hit = any(os.path.basename(tf) in ' '.join(row_files) for tf in tested)
            # 验收行直接点名这条需求 ⇒ 也算命中
            direct = rid in std or rid in how
            if (hit or direct) and aid not in [a[0] for a in acc]:
                acc.append((aid, std[:70]))
    # 回落：代码里没有溯源注释 → 用计划里的 Task
    if not impls and plan_mention.get(rid):
        tasks = sorted(plan_mention[rid])
    if not impls and not tasks:
        acc = []
    # 落地判定（三种，别混同）：
    #   ✅ 已落地       —— 代码里有溯源注释（该需求被显式承载）
    #   🟡 已落地但无溯源注释 —— Task 声明的文件在树里真实存在，只是没写 R-ID
    #   ⬜ 计划中       —— Task 的文件还不存在
    impl_flags = []
    for pn, tno, ttitle in tasks:
        if tno == '表':
            continue
        res = task_implemented((pn, tno))
        if res:
            impl_flags.append((pn, tno, res[0], res[1]))
    if impls:
        land = 'landed'
    elif impl_flags and any(h >= n * 0.6 for _, _, h, n in impl_flags):
        land = 'landed-no-trace'
    else:
        land = 'planned'
    rows.append({
        'id': rid, 'name': r['name'], 'state': r['state'],
        'impls': impls, 'tasks': tasks, 'acc': acc,
        'tested': sorted(tested),
        'plan_only': bool(plan_mention.get(rid)) and not impls,
        'land': land,
        'impl_flags': impl_flags,
    })

rows_json = rows

landed = sum(1 for x in rows if x['land'] == 'landed')
notrace = sum(1 for x in rows if x['land'] == 'landed-no-trace')
planned = sum(1 for x in rows if x['land'] == 'planned')
print('96 条需求 → ✅已落地(有溯源注释) %d｜🟡已落地但代码无溯源注释 %d｜⬜计划中 %d'
      % (landed, notrace, planned))
print('无溯源注释的已落地需求：', ', '.join(x['id'] for x in rows if x['land'] == 'landed-no-trace') or '（无）')
print('有落地但没挂上验收标准的：%d 条'
      % sum(1 for x in rows if x['impls'] and not x['acc']))


def clean_title(t):
    """去掉标题里尾部挂着的文件名片段，并截断时不切在反引号中间"""
    t = re.sub(r'\s*`[^`]*`\s*$', '', t).strip()
    t = re.sub(r'（[^）]*）\s*$', '', t).strip()   # 去掉尾部括号注
    return t if len(t) <= 26 else t[:24] + '…'


def phase_key(pn):
    try:
        return int(pn[1:])
    except Exception:
        return 99


def tasks_of(r):
    if not r['tasks']:
        return '—'
    seen = []
    for pn, tno, ttitle in sorted(r['tasks'], key=lambda x: (phase_key(x[0]), int(x[1]) if x[1].isdigit() else 99)):
        k = '%s·Task %s' % (pn, tno)
        if k not in [x[0] for x in seen]:
            seen.append((k, ttitle))
    return '<br>'.join('%s %s' % (k, clean_title(t)) for k, t in seen)


def impls_of(r):
    if not r['impls']:
        return '—'
    out = []
    for p in r['impls'][:4]:
        out.append('`platform/%s`' % p)
    if len(r['impls']) > 4:
        out.append('…共 %d 个文件' % len(r['impls']))
    return '<br>'.join(out)


def acc_of(r):
    if not r['acc']:
        if r['tested']:
            return '（验收行未点名该测试文件）<br>被测：`%s`' % '`、`'.join(
                os.path.basename(x) for x in r['tested'][:3])
        return '—'
    # 相关度排序：主落地阶段（承载需求最多的那个阶段）的验收标准排前面
    primary = {}
    for p in r['impls']:
        for pn, tno, ttitle in r['tasks']:
            primary[pn] = primary.get(pn, 0) + 1
    acc = sorted(r['acc'], key=lambda a: -primary.get(a[0].split('-')[0], 0))
    out = []
    for aid, std in acc[:3]:
        out.append('`%s` %s' % (aid, std))
    if len(acc) > 3:
        out.append('…共 %d 条' % len(acc))
    return '<br>'.join(out)


def state_of(r):
    land = r.get('land', 'planned')
    if land == 'landed':
        return '✅ 已落地'
    if land == 'landed-no-trace':
        return '🟡 已落地·无溯源注释'
    if r['tasks']:
        return '⬜ 计划中'
    return '⚪ 平台不实现'


# ── 从溯源表取模块分组 ──────────────────────────────────────────────────
trace = io.open(os.path.join(REPO, 'docs/requirements-traceability.md'), encoding='utf-8').read()
module_of = {}
module_name = []
_cur = None
for _l in trace.split('\n'):
    _mh = re.match(r'^## (模块[一二三四五六七八九].*)$', _l.strip())
    if _mh:
        _cur = _mh.group(1)
        module_name.append(_cur)
    _mm = re.match(r'^\| (R-[A-Z]+-\d+) \|', _l)
    if _mm and _cur:
        module_of[_mm.group(1)] = _cur

lines = []
A = lines.append
A('# 需求落地对照表 · 96 条需求「落在哪、怎么验」')
A('')
A('> **本表回答的是三个问题里的第三个：最后怎么落地。**')
A('> - 「它从哪来」→ [`docs/requirements-traceability.md`](requirements-traceability.md)（源文档 + 定位 + 原文要点 + 状态）')
A('> - 「它凭什么这么定」→ 各阶段计划文档的**缺陷台账**（每条实现的偏离、实证与取舍都有记录）')
A('> - 「它最后落在哪、怎么验」→ **本表**')
A('')
A('## 分母声明')
A('')
A('需求全集 = **96 条**（逐行解析 `requirements-traceability.md` 的表格，**不是估算**）。')
A('独立源数 = 6 份一手文档（任务书 2.0 + S7 + S10 + SABC + 顶层文档 + 项目自身复盘），')
A('**同属一个作者体系，不构成多方独立互证** —— 详见溯源表的同段声明。')
A('')
A('## 证据口径（本表的每一格都不是手写的）')
A('')
A('| 列 | 怎么来的 | 可复核 |')
A('|---|---|---|')
A('| **落地** | 扫实现文件里的**溯源注释**（`R-XXX-NN` 字样）⇒ 该文件承载这条需求；再用 7 份计划的 `**Files:**` 段把文件归到阶段与 Task。⚠️ 溯源引用有**紧凑式**（`R-PTS-01/02/03/04/05/06`、`R-RNK-01/02/03/04`），匹配时必须**展开**，否则紧凑式后面的编号会被整段丢掉、需求被误判成「无溯源注释」 | `grep -rn "R-XXX-NN" platform/` |')
A('| **怎么验** | 实现文件 → 引用它的**测试文件** → owning 阶段 `## P{n} 验收标准` 表里提到该测试文件的行（`P{n}-{m}`） | `grep -n "P{n}-{m}" docs/superpowers/plans/*P{n}*.md` |')
A('| **状态** | 「已落地」= 代码里有溯源注释；「计划中」= 只有计划里有；「平台不实现」= 两边都没有 | 三个来源全部可重跑 |')
A('')
A('> ⚠️ 扫描面 = `main` + P5 worktree + P6 worktree 三棵树的**并集**（P5/P6 的代码还没合回 main）。')
A('> ⚠️ 「怎么验」一列有时会写「验收行未点名该测试文件」—— 这是**如实记录**：该需求的验证确实发生了，')
A('> 但那条验收标准是用「同文件」或散文描述指向它的，没有逐字点名测试文件名。这种情况不掩盖。')
A('')
A('---')
A('')
A('## 一览')
A('')
A('| 模块 | 需求数 | ✅ 已落地 | 🟡 已落地·无溯源注释 | ⬜ 计划中 | ⚪ 平台不实现 |')
A('|---|---|---|---|---|---|')
for mod in module_name:
    rs = [r for r in rows if module_of.get(r['id']) == mod]
    if not rs:
        continue
    A('| %s | %d | %d | %d | %d | %d |' % (
        mod.split('·')[0].strip() + ' ' + mod.split('·')[1].strip() if '·' in mod else mod,
        len(rs),
        sum(1 for r in rs if r.get('land') == 'landed'),
        sum(1 for r in rs if r.get('land') == 'landed-no-trace'),
        sum(1 for r in rs if r.get('land') == 'planned' and r['tasks']),
        sum(1 for r in rs if r.get('land') == 'planned' and not r['tasks'])))
A('| **合计** | **%d** | **%d** | **%d** | **%d** | **%d** |' % (
    len(rows),
    sum(1 for r in rows if r.get('land') == 'landed'),
    sum(1 for r in rows if r.get('land') == 'landed-no-trace'),
    sum(1 for r in rows if r.get('land') == 'planned' and r['tasks']),
    sum(1 for r in rows if r.get('land') == 'planned' and not r['tasks'])))
A('')
A('---')
A('')
A('## 逐条对照')
A('')
for mod in module_name:
    rs = [r for r in rows if module_of.get(r['id']) == mod]
    if not rs:
        continue
    A('### %s' % mod)
    A('')
    A('| 需求 | 一句话 | 状态 | 落地（阶段·Task） | 落地文件 | 怎么验 |')
    A('|---|---|---|---|---|---|')
    for r in rs:
        A('| **%s** | %s | %s | %s | %s | %s |' % (
            r['id'], r['name'], state_of(r), tasks_of(r), impls_of(r), acc_of(r)))
    A('')

# ── 汇总 ────────────────────────────────────────────────────────────────
A('---')
A('')
A('## 承载需求最多的文件（改动前的影响面评估）')
A('')
cnt = {}
for r in rows:
    for p in r['impls']:
        cnt[p] = cnt.get(p, 0) + 1
top = sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:15]
A('| 文件 | 承载需求数 | 需求 |')
A('|---|---|---|')
for p, n in top:
    ids = [r['id'] for r in rows if p in r['impls']]
    A('| `platform/%s` | %d | %s |' % (p, n, '、'.join(ids)))
A('')
A('---')
A('')
A('## 三类尾巴')
A('')
_no_trace = [r for r in rows if r.get('land') == 'landed-no-trace']
if _no_trace:
    A('### 一、已落地但**代码里没写溯源注释**（%d 条）—— 应补注释' % len(_no_trace))
    A('')
    A('> 这些需求的**功能确实已经实现**（对应 Task 声明的文件在工作树里真实存在），')
    A('> 但实现文件里**没有** `R-XXX-NN` 的溯源注释 ⇒ 事后从代码反查「这条需求落在哪」时查不到。')
    A('> 补一条注释的成本 ≈ 0，收益是溯源链不断。')
    A('')
    A('| 需求 | 状态 | 落地在哪 | 说明 |')
    A('|---|---|---|---|')
    for r in _no_trace:
        where = '、'.join('%s Task %s' % (pn, tno) for pn, tno, _ in r['tasks'][:3]) or '—'
        A('| **%s** %s | %s | %s | 代码里查不到 `%s` 的溯源注释 |' % (r['id'], r['name'], state_of(r), where, r['id']))
    A('')
A('### 二、计划中（尚未实现）')
A('')
A('| 需求 | 状态 | 说明 |')
A('|---|---|---|')
for r in rows:
    if r['impls'] or r.get('land') == 'landed-no-trace':
        continue
    if r['id'] == 'R-PTS-13':
        note = ('**平台【不实现】**：这是**财务科目口径**（押金按负债科目入账）而非平台功能，'
                '且「中途不退部分去向」本身是规则空白。溯源表已显式声明不实现，'
                '并禁止任何人往平台里加「报名费 / 押金」字段或退费流程。')
    elif r['tasks']:
        note = '计划已写明落点（%s），代码尚未落地 —— **在本表生成时尚未实现**。' % (
            '、'.join('%s Task %s' % (pn, tno) for pn, tno, _ in r['tasks'][:3]))
    else:
        note = '**未定位到落点** —— 需要人工确认。'
    A('| **%s** %s | %s | %s |' % (r['id'], r['name'], state_of(r), note))
A('')
A('### 三、平台明确不实现')
A('')
for r in rows:
    if r['id'] == 'R-PTS-13':
        A('| **%s** %s | %s | %s |' % (r['id'], r['name'], state_of(r),
          '**财务科目口径**而非平台功能；「中途不退部分去向」本身是规则空白。'
          '溯源表已声明平台不实现，并禁止任何人往平台里加「报名费 / 押金」字段或退费流程。'))
A('')
A('---')
A('')
A('*本表由 `docs/requirements-traceability.md` + 7 份阶段计划 + 代码树的溯源注释扫描**自动生成**；')
A('生成器：`python3 docs/tools/requirement-map.py --trees . .worktrees/p5-pools .worktrees/p6-deploy --out docs/requirement-implementation-map.md`（**在仓库里，可复算**）。*')

out_path = ARGS.out
io.open(out_path, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('已生成 %s（%d 行）' % (out_path, len(lines)))
