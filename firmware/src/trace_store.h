/* Bounded, interrupted-write-safe trace records on a key/value backend. */
#ifndef OPENFLOAT_TRACE_STORE_H
#define OPENFLOAT_TRACE_STORE_H

#include "trace_buffer.h"

#define TRACE_STORE_SLOTS 4
#define TRACE_STORE_PART_SIZE 512
#define TRACE_STORE_PARTS ((sizeof(struct stored_trace) + TRACE_STORE_PART_SIZE - 1) / TRACE_STORE_PART_SIZE)
#define TRACE_STORE_MANIFEST_PART TRACE_STORE_PARTS

struct trace_store_entry {
	uint32_t generation;
	bool valid;
};

struct trace_store {
	struct trace_store_entry entries[TRACE_STORE_SLOTS];
	bool ready;
};

/* Reads must return 0 only for an exact-length value, -ENOENT for missing keys,
 * or -EBADMSG for a wrong length. Writes return 0 on success; NULL/0 deletes.
 * Length and CRC checks reject incomplete values. Callers serialize operations;
 * no multi-key transaction is required. */
struct trace_store_io {
	void *context;
	int (*read)(void *context, unsigned int slot, unsigned int part, void *data, size_t size);
	int (*write)(void *context, unsigned int slot, unsigned int part, const void *data, size_t size);
};

/* Reuses caller-owned scratch. Visits complete records oldest first, so a
 * reused shot ID or RAM slot is replaced by its newest committed capture. */
int trace_store_load(struct trace_store *store, const struct trace_store_io *io,
		     struct stored_trace *scratch,
		     void (*restored)(void *context, const struct stored_trace *trace), void *context);
int trace_store_save(struct trace_store *store, const struct trace_store_io *io,
		     const struct stored_trace *trace);

#endif
