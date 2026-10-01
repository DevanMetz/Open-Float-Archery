"""Run the real Zephyr ZMS implementation against a bounded host RRAM model.

No SDK sources are copied or modified. The shim replaces hardware, logging,
and mutex calls for this single-threaded capacity test. Trace-store power-loss
checks are separate, in firmware/tests/trace_store_test.c.
"""

import argparse
from pathlib import Path
import subprocess
import tempfile


HOST_HEADER = r"""
#ifndef OPENFLOAT_HOST_ZMS_H
#define OPENFLOAT_HOST_ZMS_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <assert.h>
#include <string.h>
#include <sys/types.h>
#ifdef _WIN32
typedef intptr_t ssize_t;
#endif
#define __packed __attribute__((packed))
#define __maybe_unused __attribute__((unused))
#define CONFIG_ZMS_LOG_LEVEL 0
#define GENMASK(h,l) ((UINT32_MAX << (l)) & (UINT32_MAX >> (31-(h))))
#define GENMASK64(h,l) ((UINT64_MAX << (l)) & (UINT64_MAX >> (63-(h))))
#define FIELD_GET(m,v) (((v) & (m)) / ((m) & (0-(m))))
#define FIELD_PREP(m,v) (((v) * ((m) & (0-(m)))) & (m))
#define SIZEOF_FIELD(t,f) sizeof(((t *)0)->f)
#define MIN(a,b) ((a)<(b)?(a):(b))
#define BIT(n) (UINT32_C(1) << (n))
#define K_FOREVER 0
struct k_mutex { int unused; };
static inline void k_mutex_init(struct k_mutex *m) { (void)m; }
static inline void k_mutex_lock(struct k_mutex *m,int t) { (void)m; (void)t; }
static inline void k_mutex_unlock(struct k_mutex *m) { (void)m; }
struct device { int unused; };
struct flash_parameters { size_t write_block_size; uint8_t erase_value; };
struct flash_pages_info { size_t size; };
#define FLASH_ERASE_C_EXPLICIT 1
static inline int flash_params_get_erase_cap(const struct flash_parameters *p) { (void)p; return 0; }
const struct flash_parameters *flash_get_parameters(const struct device *d);
int flash_get_page_info_by_offs(const struct device *d, off_t o, struct flash_pages_info *i);
int flash_read(const struct device *d, off_t o, void *b, size_t n);
int flash_write(const struct device *d, off_t o, const void *b, size_t n);
int flash_erase(const struct device *d, off_t o, size_t n);
static inline uint8_t crc8_ccitt(uint8_t c, const uint8_t *b, size_t n) {
 for (size_t i=0;i<n;i++) { c ^= b[i]; for(int j=0;j<8;j++) c=(uint8_t)((c<<1)^((c&0x80)?7:0)); } return c;
}
#define LOG_MODULE_REGISTER(...)
#define LOG_INF(...)
#define LOG_DBG(...)
#define LOG_ERR(...)
#endif
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zephyr", type=Path, required=True, help="Path to the SDK's zephyr directory")
    parser.add_argument("--cc", default="clang", help="C11 host compiler (Clang or GCC)")
    args = parser.parse_args()
    zephyr = args.zephyr.resolve()
    source = zephyr / "subsys/fs/zms/zms.c"
    header = zephyr / "include/zephyr/fs/zms.h"
    if not source.is_file() or not header.is_file():
        parser.error("--zephyr must contain the ZMS source and public header")
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="openfloat-zms-") as directory:
        shim = Path(directory)
        (shim / "host.h").write_text(HOST_HEADER, encoding="ascii")
        headers = {
            "zephyr/fs/zms.h": f'#include "{header.as_posix()}"\n',
        }
        for name in ("drivers/flash.h", "kernel.h", "device.h", "toolchain.h", "sys/crc.h", "logging/log.h"):
            headers[f"zephyr/{name}"] = '#include "host.h"\n'
        for name, text in headers.items():
            path = shim / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="ascii")
        executable = shim / "zms_capacity_test.exe"
        subprocess.run([
            args.cc, "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-Wno-unused-parameter", "-Wno-sign-compare",
            f"-I{repo / 'firmware/src'}", f"-I{shim}", "-include", str(shim / "host.h"),
            str(source), str(repo / "firmware/src/trace_store.c"),
            str(repo / "firmware/tests/zms_capacity_test.c"), "-o", str(executable),
        ], check=True)
        subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    main()
