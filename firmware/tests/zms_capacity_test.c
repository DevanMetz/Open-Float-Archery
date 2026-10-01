/* Capacity/GC check against the SDK's unchanged ZMS implementation.
 * Index entries reserve more space than Settings' actual names/linked nodes.
 * The flash shim models byte-alterable RRAM, not hardware timing or power loss. */
#include "trace_store.h"
#include <zephyr/fs/zms.h>
#include <stdio.h>
#include <errno.h>

static uint8_t rram[65536];
static const struct device device;
static const struct flash_parameters parameters = { 16, 0xff };
static struct zms_fs fs;
static struct stored_trace input, scratch;
static uint32_t restored_id[TRACE_STORE_SLOTS];
static unsigned int restored_count;
static uint8_t shotlog[2804];

const struct flash_parameters *flash_get_parameters(const struct device *dev)
{
	(void)dev;
	return &parameters;
}

int flash_get_page_info_by_offs(const struct device *dev, off_t offset, struct flash_pages_info *info)
{
	(void)dev;
	(void)offset;
	info->size = 4096;
	return 0;
}

int flash_read(const struct device *dev, off_t offset, void *data, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram));
	memcpy(data, rram + offset, size);
	return 0;
}

int flash_write(const struct device *dev, off_t offset, const void *data, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram) && offset % 16 == 0 && size % 16 == 0);
	memcpy(rram + offset, data, size);
	return 0;
}

int flash_erase(const struct device *dev, off_t offset, size_t size)
{
	(void)dev;
	assert(offset >= 0 && (size_t)offset + size <= sizeof(rram));
	memset(rram + offset, 0xff, size);
	return 0;
}

static uint32_t key(unsigned int slot, unsigned int part)
{
	return 1000 + slot * 100 + part * 3;
}

static int read_value(void *context, unsigned int slot, unsigned int part, void *data, size_t size)
{
	(void)context;
	ssize_t length = zms_get_data_length(&fs, key(slot, part));
	if (length < 0) return (int)length;
	if ((size_t)length != size) return -EBADMSG;
	ssize_t rc = zms_read(&fs, key(slot, part), data, size);
	return rc < 0 ? (int)rc : ((size_t)rc == size ? 0 : -EBADMSG);
}

static int write_value(void *context, unsigned int slot, unsigned int part, const void *data, size_t size)
{
	(void)context;
	ssize_t rc = zms_write(&fs, key(slot, part), data, size);
	return rc < 0 ? (int)rc : 0;
}

static const struct trace_store_io io = { NULL, read_value, write_value };

static void collect(void *context, const struct stored_trace *trace)
{
	(void)context;
	assert(restored_count < TRACE_STORE_SLOTS);
	restored_id[restored_count++] = trace->shot_id;
	assert(trace->count == TRACE_CAPACITY && trace->points[999].roll_cdeg == (int16_t)(trace->shot_id + 999));
}

static void remount(void)
{
	memset(&fs, 0, sizeof(fs));
	fs.flash_device = &device;
	fs.sector_size = 4096;
	fs.sector_count = 16;
	assert(!zms_mount(&fs));
}

int main(void)
{
	memset(rram, 0xff, sizeof(rram));
	remount();
	assert(zms_write(&fs, 1, &input, sizeof(input)) == -EINVAL);
	uint8_t name[32] = { 0 };
	uint64_t link = 0;
	/* All bounded trace keys reserve 32-byte names (actual maximum 16),
	 * an eight-byte linked node, and separately written trace values. */
	for (unsigned int slot = 0; slot < TRACE_STORE_SLOTS; slot++) {
		for (unsigned int part = 0; part <= TRACE_STORE_PARTS; part++) {
			uint32_t id = key(slot, part);
			link = id;
			assert(zms_write(&fs, id + 1, name, sizeof(name)) >= 0);
			assert(zms_write(&fs, id + 2, &link, sizeof(link)) >= 0);
		}
	}
	/* Ordinary settings, two linked-list markers, and a maximum 100-shot log. */
	for (uint32_t i = 0; i < 14; i++) {
		assert(zms_write(&fs, 10 + i * 3, &link, 4) >= 0);
		assert(zms_write(&fs, 11 + i * 3, name, sizeof(name)) >= 0);
		assert(zms_write(&fs, 12 + i * 3, &link, sizeof(link)) >= 0);
	}
	assert(zms_write(&fs, 100, &link, sizeof(link)) >= 0);
	assert(zms_write(&fs, 101, &link, sizeof(link)) >= 0);
	assert(zms_write(&fs, 102, shotlog, sizeof(shotlog)) >= 0);
	struct trace_store store;
	assert(!trace_store_load(&store, &io, &scratch, NULL, NULL));
	for (uint32_t shot = 1; shot <= 100; shot++) {
		memset(&input, 0, sizeof(input));
		input.shot_id = shot;
		input.version = 1;
		input.flags = TRACE_HAS_TIMING;
		input.count = TRACE_CAPACITY;
		for (unsigned int i = 0; i < TRACE_CAPACITY; i++) {
			input.points[i].roll_cdeg = (int16_t)(shot + i);
			input.points[i].dt_ms = i ? 19 : 0;
		}
		int rc = trace_store_save(&store, &io, &input);
		if (rc) {
			fprintf(stderr, "ZMS save %u failed: %d, free=%lld\n", shot, rc, (long long)zms_calc_free_space(&fs));
			return 1;
		}
		/* Stress additional shot-log and linked-list churn through actual GC. */
		shotlog[0] = (uint8_t)shot;
		link = shot;
		assert(zms_write(&fs, 102, shotlog, sizeof(shotlog)) >= 0);
		assert(zms_write(&fs, 101, &link, sizeof(link)) >= 0);
		remount();
		restored_count = 0;
		assert(!trace_store_load(&store, &io, &scratch, collect, NULL));
		unsigned int expected = shot < TRACE_STORE_SLOTS ? shot : TRACE_STORE_SLOTS;
		assert(restored_count == expected);
		for (unsigned int i = 0; i < expected; i++) assert(restored_id[i] == shot - expected + 1 + i);
		uint8_t check[sizeof(shotlog)];
		assert(zms_read(&fs, 102, check, sizeof(check)) == sizeof(check) && !memcmp(shotlog, check, sizeof(check)));
	}
	printf("SDK ZMS capacity/GC passed: 100 full traces, 100 shot-log updates, 100 remounts, 64 KB partition; free=%lld bytes.\n", (long long)zms_calc_free_space(&fs));
	return 0;
}
