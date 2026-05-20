#!/bin/bash
# 检查旧品牌、旧云入口和旧产品语义残留。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== 公司本地残留检查 ==="
echo ""

PATTERN='旧云服务域名|旧云服务目录'

if command -v rg >/dev/null 2>&1; then
  rg -n "$PATTERN" src scripts package.json README.md docs installers e2e 2>/dev/null || true
else
  grep -RInE "$PATTERN" src scripts package.json README.md docs installers e2e 2>/dev/null || true
fi

echo ""
echo "如有输出，请逐项迁移到本地公司、小老板、员工、会议、银行等语义。"
