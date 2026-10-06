"""Run the real Zephyr ZMS implementation against a bounded host RRAM model.

No SDK sources are copied or modified. The shim replaces hardware, logging,
and mutex calls for single-threaded capacity, write-suppression, sleep-flush,
background-save, and boot-read checks. The boot model compiles the SDK Settings/ZMS backend
and its selected Murmur3 hash implementation without modifying either source.
ZMS_NO_DOUBLE_WRITE matches firmware/prj.conf. Trace-store power-loss
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
#define CONFIG_ZMS_NO_DOUBLE_WRITE 1
#define CONFIG_SETTINGS_ZMS 1
#define CONFIG_SETTINGS_ZMS_MAX_COLLISIONS_BITS 4
#define CONFIG_SETTINGS_ZMS_SECTOR_SIZE_MULT 1
#define CONFIG_SYS_HASH_FUNC32_CHOICE_IDENTITY 0
#define CONFIG_SYS_HASH_FUNC32_CHOICE_DJB2 0
#define CONFIG_SYS_HASH_FUNC32_CHOICE_MURMUR3 1
#define IS_ENABLED(c) (c)
#define IS_ALIGNED(p,n) (!((uintptr_t)(p) & ((n)-1)))
#define CONTAINER_OF(p,t,m) ((t *)((uint8_t *)(p)-offsetof(t,m)))
#define LSB_GET(v) ((v) & (0-(v)))
#define __ASSERT(c,...) assert(c)
#define __ASSERT_NO_MSG(c) assert(c)
static inline uint32_t host_unaligned32(const void *p) { uint32_t v; memcpy(&v,p,4); return v; }
#define UNALIGNED_GET(p) host_unaligned32(p)
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
typedef struct { void *next; } sys_snode_t;
typedef struct { void *head, *tail; } sys_slist_t;
struct flash_area { const struct device *fa_dev; off_t fa_off; size_t fa_size; };
struct flash_sector { off_t fs_off; size_t fs_size; };
#define DT_HAS_CHOSEN(n) 0
#define FIXED_PARTITION_ID(n) 0
int flash_area_open(int id, const struct flash_area **area);
int flash_area_get_sectors(int id, uint32_t *count, struct flash_sector *sector);
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
#define LOG_MODULE_DECLARE(...)
#define LOG_WRN(...)
#define LOG_INF(...)
#define LOG_DBG(...)
#define LOG_ERR(...)
#endif
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zephyr", type=Path, required=True, help="Path to the SDK's zephyr directory")
    parser.add_argument("--cc", default="clang", help="C11 host compiler (Clang or GCC)")
    parser.add_argument("--temp-dir", type=Path, help="Existing directory for temporary build files (default: OS temp)")
    args = parser.parse_args()
    zephyr = args.zephyr.resolve()
    source = zephyr / "subsys/fs/zms/zms.c"
    header = zephyr / "include/zephyr/fs/zms.h"
    settings_source = zephyr / "subsys/settings/src/settings_zms.c"
    settings_header = zephyr / "subsys/settings/include/settings/settings_zms.h"
    hash_source = zephyr / "lib/hash/hash_func32_murmur3.c"
    if not all(path.is_file() for path in (source, header, settings_source, settings_header, hash_source)):
        parser.error("--zephyr must contain ZMS, Settings/ZMS, and Murmur3 sources/headers")
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="openfloat-zms-", dir=args.temp_dir) as directory:
        shim = Path(directory)
        (shim / "host.h").write_text(HOST_HEADER, encoding="ascii")
        headers = {
            "zephyr/fs/zms.h": f'#include "{header.as_posix()}"\n',
            "settings/settings_zms.h": f'#include "{settings_header.as_posix()}"\n',
            "settings/backend_under_test.h": f'#include "{settings_source.as_posix()}"\n',
        }
        for name in ("settings/settings.h", "sys/hash_function.h"):
            headers[f"zephyr/{name}"] = f'#include "{(zephyr / "include/zephyr" / name).as_posix()}"\n'
        for name in ("drivers/flash.h", "kernel.h", "device.h", "toolchain.h", "sys/crc.h", "logging/log.h",
                     "sys/util.h", "sys/util_macro.h", "sys/slist.h", "sys/iterable_sections.h",
                     "sys/__assert.h", "storage/flash_map.h"):
            headers[f"zephyr/{name}"] = '#include "host.h"\n'
        for name, text in headers.items():
            path = shim / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="ascii")
        executable = shim / "zms_capacity_test.exe"
        flags = [
            "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-Wno-unused-parameter", "-Wno-sign-compare",
            f"-I{repo / 'firmware/src'}", f"-I{shim}", "-include", str(shim / "host.h"),
        ]
        sources = [source, repo / "firmware/src/trace_store.c", repo / "firmware/src/shot_log.c",
                   repo / "firmware/src/trace_buffer.c", repo / "firmware/src/settings_retry.c", repo / "firmware/src/sleep_flush.c",
                   repo / "firmware/tests/zms_capacity_test.c"]
        objects = []
        for path in sources:
            obj = shim / f"{path.stem}.o"
            subprocess.run([args.cc, *flags, "-c", str(path), "-o", str(obj)], check=True)
            objects.append(str(obj))
        subprocess.run([args.cc, *objects, "-o", str(executable)], check=True)
        subprocess.run([str(executable)], check=True)
        boot_objects = objects[:6]
        for path in (hash_source, repo / "firmware/src/boot_restore.c",
                     repo / "firmware/src/settings_read.c", repo / "firmware/src/shot_recovery.c",
                     repo / "firmware/tests/settings_boot_test.c"):
            obj = shim / f"{path.stem}.o"
            extra_flags = []
            if path.name == "settings_read.c":
                extra_flags = ["-Dzms_read=boot_test_zms_read", "-Dzms_get_data_length=boot_test_zms_get_data_length"]
            subprocess.run([args.cc, *flags, *extra_flags, "-c", str(path), "-o", str(obj)], check=True)
            boot_objects.append(str(obj))
        boot_executable = shim / "settings_boot_test.exe"
        subprocess.run([args.cc, *boot_objects, "-o", str(boot_executable)], check=True)
        subprocess.run([str(boot_executable)], check=True)


if __name__ == "__main__":
    main()
