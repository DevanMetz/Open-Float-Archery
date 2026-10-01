#include "trace_store.h"
#include <errno.h>
#include <string.h>

#define MANIFEST_SIZE 20
#define TRACE_HEADER_SIZE offsetof(struct stored_trace, points)

_Static_assert(TRACE_HEADER_SIZE == 12, "Trace header layout changed");
_Static_assert(TRACE_STORE_PARTS == 16, "Trace storage key range changed");

static uint32_t read32(const uint8_t *p)
{
	return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void write32(uint8_t *p, uint32_t value)
{
	for (unsigned int i = 0; i < 4; i++) p[i] = (uint8_t)(value >> (i * 8));
}

static uint32_t crc_update(uint32_t crc, const void *data, size_t size)
{
	const uint8_t *bytes = data;
	for (size_t i = 0; i < size; i++) {
		crc ^= bytes[i];
		for (int bit = 0; bit < 8; bit++) {
			crc = (crc >> 1) ^ ((crc & 1) ? UINT32_C(0xedb88320) : 0);
		}
	}
	return crc;
}

static size_t trace_size(const struct stored_trace *trace)
{
	return TRACE_HEADER_SIZE + trace->count * sizeof(struct trace_point);
}

static bool valid_trace(const struct stored_trace *trace)
{
	return trace->version == 1 && !(trace->flags & ~TRACE_HAS_TIMING) &&
		trace->count > 0 && trace->count <= TRACE_CAPACITY && !trace->points[0].dt_ms;
}

/* Live generations are at most four commits apart, including across wrap. */
static bool newer(uint32_t a, uint32_t b)
{
	return a != b && (uint32_t)(a - b) < UINT32_C(0x80000000);
}

static int oldest(const struct trace_store *store, unsigned int visited)
{
	int slot = -1;
	for (unsigned int i = 0; i < TRACE_STORE_SLOTS; i++) {
		if (!store->entries[i].valid || (visited & (1u << i))) continue;
		if (slot < 0 || newer(store->entries[slot].generation, store->entries[i].generation)) slot = (int)i;
	}
	return slot;
}

static int load_record(const struct trace_store_io *io, unsigned int slot,
		       struct stored_trace *scratch, uint32_t *generation)
{
	uint8_t manifest[MANIFEST_SIZE];
	int rc = io->read(io->context, slot, TRACE_STORE_MANIFEST_PART, manifest, sizeof(manifest));
	if (rc) return rc;
	uint32_t size = read32(manifest + 12);
	if (memcmp(manifest, "OFT1", 4) || size < TRACE_HEADER_SIZE + sizeof(struct trace_point) ||
	    size > sizeof(*scratch)) return -EBADMSG;
	memset(scratch, 0, sizeof(*scratch));
	for (size_t offset = 0; offset < size; offset += TRACE_STORE_PART_SIZE) {
		size_t length = size - offset;
		if (length > TRACE_STORE_PART_SIZE) length = TRACE_STORE_PART_SIZE;
		rc = io->read(io->context, slot, offset / TRACE_STORE_PART_SIZE, (uint8_t *)scratch + offset, length);
		if (rc) return rc;
	}
	uint32_t crc = crc_update(UINT32_MAX, manifest, MANIFEST_SIZE - 4);
	crc = ~crc_update(crc, scratch, size);
	if (!valid_trace(scratch) || trace_size(scratch) != size ||
	    scratch->shot_id != read32(manifest + 8) || crc != read32(manifest + 16)) return -EBADMSG;
	*generation = read32(manifest + 4);
	return 0;
}

int trace_store_load(struct trace_store *store, const struct trace_store_io *io,
		     struct stored_trace *scratch,
		     void (*restored)(void *context, const struct stored_trace *trace), void *context)
{
	memset(store, 0, sizeof(*store));
	/* Verify generations before sorting. A corrupt, unchecked generation could
	 * reorder valid records across the sequence wrap and replace a newer RAM
	 * capture with an older one. Two passes reuse scratch without extra traces. */
	for (unsigned int slot = 0; slot < TRACE_STORE_SLOTS; slot++) {
		int rc = load_record(io, slot, scratch, &store->entries[slot].generation);
		if (rc == -ENOENT || rc == -EBADMSG) continue;
		if (rc) return rc;
		store->entries[slot].valid = true;
	}
	unsigned int visited = 0;
	int slot;
	while (restored && (slot = oldest(store, visited)) >= 0) {
		visited |= 1u << slot;
		uint32_t generation;
		int rc = load_record(io, slot, scratch, &generation);
		if (rc) return rc;
		if (generation != store->entries[slot].generation) return -EAGAIN;
		restored(context, scratch);
	}
	store->ready = true;
	return 0;
}

int trace_store_save(struct trace_store *store, const struct trace_store_io *io,
		     const struct stored_trace *trace)
{
	if (!store->ready) return -EACCES;
	if (!valid_trace(trace)) return -EINVAL;
	int slot = -1, latest = -1;
	for (unsigned int i = 0; i < TRACE_STORE_SLOTS; i++) {
		if (!store->entries[i].valid) {
			if (slot < 0) slot = (int)i;
		} else if (latest < 0 || newer(store->entries[i].generation, store->entries[latest].generation)) {
			latest = (int)i;
		}
	}
	if (slot < 0) slot = oldest(store, 0);
	uint32_t generation = latest < 0 ? 1 : store->entries[latest].generation + 1;
	/* The oldest slot becomes staging. Its other three complete records remain
	 * untouched. Invalidate before replacing any piece; publish only at the end. */
	int rc = io->write(io->context, slot, TRACE_STORE_MANIFEST_PART, NULL, 0);
	if (rc) return rc;
	store->entries[slot].valid = false;
	/* Release the entire obsolete record before allocating its replacement.
	 * This gives ZMS GC contiguous room for the larger compact shot-log value,
	 * and removes stale tails when a shorter trace reuses a full-trace slot. */
	for (unsigned int part = 0; part < TRACE_STORE_PARTS; part++) {
		rc = io->write(io->context, slot, part, NULL, 0);
		if (rc) return rc;
	}
	size_t size = trace_size(trace);
	for (size_t offset = 0; offset < size; offset += TRACE_STORE_PART_SIZE) {
		size_t length = size - offset;
		if (length > TRACE_STORE_PART_SIZE) length = TRACE_STORE_PART_SIZE;
		rc = io->write(io->context, slot, offset / TRACE_STORE_PART_SIZE, (const uint8_t *)trace + offset, length);
		if (rc) return rc;
	}
	/* Little-endian manifest: magic/version, generation, shot ID, byte count,
	 * CRC-32/ISO-HDLC over the first 16 manifest bytes and the used trace bytes.
	 * The generation and ID are checksummed along with angles/audio/timing. */
	uint8_t manifest[MANIFEST_SIZE] = { 'O', 'F', 'T', '1' };
	write32(manifest + 4, generation);
	write32(manifest + 8, trace->shot_id);
	write32(manifest + 12, (uint32_t)size);
	uint32_t crc = crc_update(UINT32_MAX, manifest, MANIFEST_SIZE - 4);
	write32(manifest + 16, ~crc_update(crc, trace, size));
	rc = io->write(io->context, slot, TRACE_STORE_MANIFEST_PART, manifest, sizeof(manifest));
	if (rc) return rc;
	store->entries[slot] = (struct trace_store_entry){ .generation = generation, .valid = true };
	return 0;
}
