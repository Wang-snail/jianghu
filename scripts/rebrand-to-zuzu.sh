#!/bin/bash
# 批量替换脚本：江湖 -> 江湖

echo "开始品牌重命名..."

# 定义替换规则
declare -A REPLACEMENTS=(
    ["江湖"]="江湖"
    ["COMPANY"]="江湖"
    ["company"]="zuzu"  # 代码引用使用小写zuzu
)

# 需要处理的目录和文件
DIRS=(
    "src/ui"
    "src/server"
    "src/shared"
    "src/mcp"
    "src/cli"
    "README.md"
    ".github"
)

# 备份函数
backup_file() {
    cp "$1" "$1.backup"
}

# 处理单个文件
process_file() {
    local file="$1"
    echo "Processing: $file"

    # 创建备份
    backup_file "$file"

    # 执行替换
    for key in "${!REPLACEMENTS[@]}"; do
        value="${REPLACEMENTS[$key]}"
        case "$(uname)" in
            Darwin)
                # macOS
                sed -i '' "s/$key/$value/g" "$file"
                ;;
            Linux)
                # Linux
                sed -i "s/$key/$value/g" "$file"
                ;;
        esac
    done
}

export -f backup_file
export -f process_file

# 查找并处理所有相关文件
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.json" -o -name "*.md" \) | while read file; do
    process_file "$file"
done

# 处理README
if [ -f "README.md" ]; then
    process_file "README.md"
fi

# 处理HTML
find src/ui -type f -name "*.html" | while read file; do
    process_file "$file"
done

echo "品牌重命名完成！"
echo "备份文件已创建（.backup后缀）"
echo "如需恢复，运行: find . -name '*.backup' -exec sh -c 'mv \"$1\" \"${1%.backup}\"' _ {} \;"
