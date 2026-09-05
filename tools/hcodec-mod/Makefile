# SPDX-License-Identifier: MIT OR GPL-2.0
#
# 树外 kbuild。厂商切片（vendor.inc / venc_types.h / *_regs.h）不在仓库里，
# 由 tools/hcenc/fetch-vendor.sh 下载并和本目录的文件拼到同一个目录里再编。
#
#   tools/hcenc/fetch-vendor.sh /tmp/hcbuild
#   make -C /lib/modules/$(uname -r)/build M=/tmp/hcbuild modules

obj-m := meson_hcodec.o

ccflags-y := -I$(src) \
	-Wno-unused-function -Wno-unused-variable -Wno-unused-but-set-variable \
	-Wno-missing-prototypes -Wno-missing-declarations \
	-Wno-declaration-after-statement -Wno-sign-compare

KDIR ?= /lib/modules/$(shell uname -r)/build

all:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules

clean:
	$(MAKE) -C $(KDIR) M=$(CURDIR) clean

.PHONY: all clean
