#!/bin/bash
# USB OTG DTB 修复脚本
# 用于在构建流程中自动应用设备树修复
#
# 功能：
# 1. 从原始 DTB 或运行系统提取设备树
# 2. 添加 resets = <0x11 0x22>; 到 usb@c9100000 节点
# 3. 编译修复后的 DTB
#
# 使用方法：
# ./apply-usb-otg-dtb-fix.sh <input_dtb> <output_dtb>
# 或
# ./apply-usb-otg-dtb-fix.sh /sys/firmware/fdt <output_dtb>

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查依赖
check_dependencies() {
    local missing_deps=()

    for cmd in dtc awk; do
        if ! command -v "$cmd" &> /dev/null; then
            missing_deps+=("$cmd")
        fi
    done

    if [ ${#missing_deps[@]} -gt 0 ]; then
        log_error "缺少必要工具: ${missing_deps[*]}"
        log_info "请安装: apt-get install device-tree-compiler gawk"
        exit 1
    fi
}

# 反编译 DTB
decompile_dtb() {
    local input_dtb="$1"
    local output_dts="$2"

    log_info "反编译 DTB: $input_dtb -> $output_dts"

    if [ "$input_dtb" = "/sys/firmware/fdt" ]; then
        dtc -I fs -O dts -o "$output_dts" /proc/device-tree
    else
        dtc -I dtb -O dts -o "$output_dts" "$input_dtb"
    fi

    if [ $? -ne 0 ]; then
        log_error "反编译失败"
        return 1
    fi

    log_info "反编译完成"
}

# 添加 resets 属性
add_resets_property() {
    local input_dts="$1"
    local output_dts="$2"

    log_info "添加 resets 属性到 usb@c9100000 节点"

    # 检查是否已经有 resets 属性
    if grep -A 20 'usb@c9100000' "$input_dts" | grep -q 'resets'; then
        log_warn "resets 属性已存在，跳过修改"
        cp "$input_dts" "$output_dts"
        return 0
    fi

    # 使用 awk 添加 resets 属性
    awk '
    /usb@c9100000 \{/,/\};/ {
        if (/dr_mode = "peripheral";/) {
            print
            print "\t\t\t\tresets = <0x11 0x22>;"
            next
        }
    }
    { print }
    ' "$input_dts" > "$output_dts"

    # 验证修改
    if grep -A 20 'usb@c9100000' "$output_dts" | grep -q 'resets'; then
        log_info "resets 属性添加成功"
    else
        log_error "resets 属性添加失败"
        return 1
    fi
}

# 编译 DTB
compile_dtb() {
    local input_dts="$1"
    local output_dtb="$2"

    log_info "编译 DTB: $input_dts -> $output_dtb"

    dtc -I dts -O dtb -o "$output_dtb" "$input_dts" 2>&1 | grep -v "Warning" || true

    if [ $? -ne 0 ] || [ ! -f "$output_dtb" ]; then
        log_error "编译失败"
        return 1
    fi

    log_info "编译完成"
}

# 验证 DTB
verify_dtb() {
    local dtb_file="$1"

    log_info "验证 DTB 文件"

    # 检查文件大小
    local size=$(stat -f%z "$dtb_file" 2>/dev/null || stat -c%s "$dtb_file" 2>/dev/null)
    if [ -z "$size" ] || [ "$size" -lt 1000 ]; then
        log_error "DTB 文件太小或不存在: $size bytes"
        return 1
    fi

    # 检查 DTB magic
    local magic=$(hexdump -n 4 -e '4/1 "%02x"' "$dtb_file")
    if [ "$magic" != "d00dfeed" ]; then
        log_error "DTB magic 错误: $magic (期望: d00dfeed)"
        return 1
    fi

    # 使用 dtc 验证
    if ! dtc -I dtb -O dts "$dtb_file" > /dev/null 2>&1; then
        log_error "DTB 格式验证失败"
        return 1
    fi

    log_info "DTB 验证通过 (大小: $size bytes)"
}

# 显示修改内容
show_diff() {
    local original_dts="$1"
    local fixed_dts="$2"

    log_info "修改内容:"
    echo "---"
    diff -u "$original_dts" "$fixed_dts" | grep -A 5 -B 5 "resets" || log_warn "无法显示差异"
    echo "---"
}

# 主函数
main() {
    local input_dtb="$1"
    local output_dtb="$2"

    if [ -z "$input_dtb" ] || [ -z "$output_dtb" ]; then
        echo "用法: $0 <input_dtb> <output_dtb>"
        echo ""
        echo "示例:"
        echo "  $0 /sys/firmware/fdt fixed.dtb           # 从运行系统"
        echo "  $0 original.dtb fixed.dtb                # 从 DTB 文件"
        echo "  $0 /boot/dtb/meson-gxl.dtb fixed.dtb     # 从文件系统"
        exit 1
    fi

    if [ ! -e "$input_dtb" ] && [ "$input_dtb" != "/sys/firmware/fdt" ]; then
        log_error "输入文件不存在: $input_dtb"
        exit 1
    fi

    log_info "USB OTG DTB 修复脚本"
    log_info "输入: $input_dtb"
    log_info "输出: $output_dtb"
    echo ""

    # 检查依赖
    check_dependencies

    # 创建临时目录
    local temp_dir=$(mktemp -d)
    trap "rm -rf $temp_dir" EXIT

    local original_dts="$temp_dir/original.dts"
    local fixed_dts="$temp_dir/fixed.dts"

    # 步骤 1: 反编译
    if ! decompile_dtb "$input_dtb" "$original_dts"; then
        exit 1
    fi

    # 步骤 2: 添加 resets 属性
    if ! add_resets_property "$original_dts" "$fixed_dts"; then
        exit 1
    fi

    # 步骤 3: 显示修改
    show_diff "$original_dts" "$fixed_dts"

    # 步骤 4: 编译
    if ! compile_dtb "$fixed_dts" "$output_dtb"; then
        exit 1
    fi

    # 步骤 5: 验证
    if ! verify_dtb "$output_dtb"; then
        exit 1
    fi

    echo ""
    log_info "✅ DTB 修复完成: $output_dtb"
    log_info ""
    log_info "修复内容: 添加 resets = <0x11 0x22>; 到 usb@c9100000 节点"
    log_info "解决问题: dwc2_core_reset HANG! Soft Reset timeout"
    log_info ""
    log_info "下一步:"
    log_info "  1. 将修复后的 DTB 集成到镜像构建流程"
    log_info "  2. 烧录测试镜像"
    log_info "  3. 验证 USB OTG 功能: dmesg | grep dwc2"
}

main "$@"
