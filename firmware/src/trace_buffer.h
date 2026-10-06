/* Portable trace capture, persistence migration, and wire encoding. */
#ifndef OPENFLOAT_TRACE_BUFFER_H
#define OPENFLOAT_TRACE_BUFFER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TRACE_CAPACITY 1000
#define TRACE_HAS_TIMING 1
#define TRACE_TIMED_FORMAT 0x88
#define TRACE_FRAME_SIZE 29
#define TRACE_RAM_SLOTS 10

struct trace_point {
	int16_t roll_cdeg;
	int16_t pitch_cdeg;
	int16_t yaw_cdeg;
	uint8_t mic_amp;
	uint8_t dt_ms;
};

struct stored_trace {
	uint32_t shot_id;
	uint8_t version;
	uint8_t flags;
	uint16_t count;
	int32_t first_time_ms;
	struct trace_point points[TRACE_CAPACITY];
};

struct trace_ring {
	struct trace_point points[TRACE_CAPACITY];
	uint16_t count;
	uint16_t write_idx;
	uint32_t last_ms;
};

/* Caller holds the trace mutex. Failed captures remain unsaved after three
 * ordinary attempts and can be selected explicitly by the shutdown flush.
 * Reusing a RAM slot changes its token before an old write can complete.
 */
struct trace_persist_queue {
	uint32_t pending_mask, failed_mask, generation;
	uint32_t order[TRACE_RAM_SLOTS];
	uint8_t attempts[TRACE_RAM_SLOTS];
};

void trace_persist_forget(struct trace_persist_queue *queue, unsigned int slot);
void trace_persist_ready(struct trace_persist_queue *queue, unsigned int slot);
int trace_persist_take(struct trace_persist_queue *queue, uint32_t eligible_mask,
		       bool include_failed, uint32_t *token);
bool trace_persist_finish(struct trace_persist_queue *queue, unsigned int slot, uint32_t token, int result);

void trace_ring_push(struct trace_ring *ring, struct trace_point point, uint32_t now_ms);
void trace_ring_freeze(const struct trace_ring *ring, struct stored_trace *dest,
		       uint32_t shot_id, uint32_t release_ms);
bool trace_restore(struct stored_trace *dest, const uint8_t *bytes, size_t size);
uint32_t trace_wire_crc(const struct stored_trace *trace);
uint16_t trace_chunk_count(const struct stored_trace *trace, unsigned int mode);
bool trace_build_chunk(const struct stored_trace *trace, unsigned int mode,
		      uint16_t index, uint32_t crc, uint8_t frame[TRACE_FRAME_SIZE]);

#endif
