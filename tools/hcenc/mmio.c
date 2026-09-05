// SPDX-License-Identifier: MIT
// 单字 MMIO peek/poke，走 /dev/mem。hcodec 上电序列和寄存器复查都靠它。
//
//   gcc -O2 -o mmio mmio.c
//   ./mmio 0xc883c1e0            # 读
//   ./mmio 0xc883c1e0 0x01020000 # 写（写完回读一次）
//
// 注意：hcodec 子块（0xc8824xxx / 0xc8826xxx）在上电+解除隔离之前读会挂总线，
// 整机死等到看门狗复位，dmesg 什么都留不下。先跑 hcodec_up.sh。
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	unsigned long addr, base;
	volatile uint32_t *p;
	long ps;
	void *m;
	int fd;

	if (argc < 2) {
		fprintf(stderr, "usage: %s <phys-addr> [value]\n", argv[0]);
		return 2;
	}
	addr = strtoul(argv[1], NULL, 0);
	ps = sysconf(_SC_PAGESIZE);
	base = addr & ~(unsigned long)(ps - 1);

	fd = open("/dev/mem", O_RDWR | O_SYNC);
	if (fd < 0) {
		perror("open /dev/mem");
		return 1;
	}
	m = mmap(NULL, ps, PROT_READ | PROT_WRITE, MAP_SHARED, fd, base);
	if (m == MAP_FAILED) {
		perror("mmap");
		return 1;
	}
	p = (volatile uint32_t *)((char *)m + (addr - base));

	if (argc >= 3) {
		uint32_t v = (uint32_t)strtoul(argv[2], NULL, 0);

		*p = v;
		printf("W %08lx <- %08x  (readback %08x)\n", addr, v, *p);
	} else {
		printf("R %08lx -> %08x\n", addr, *p);
	}
	munmap(m, ps);
	close(fd);
	return 0;
}
