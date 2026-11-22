// margin-core's hosting core behind a C interface (app/shared/ffi/src/lib.rs, Rust): what Margin.app's Swift calls
// through `import MarginCore`. Every function takes null or bad input without harm; nothing here keeps global state.
#ifndef MARGIN_FFI_H
#define MARGIN_FFI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct MarginRect {
    double x;
    double y;
    double width;
    double height;
} MarginRect;

typedef struct MarginEdges {
    double left;
    double right;
    double top;
    double bottom;
} MarginEdges;

typedef struct MarginPlacement {
    MarginRect page;
    MarginRect area;
    MarginRect display;
} MarginPlacement;

typedef struct MarginHostCore MarginHostCore;

// A hosting core, freed with margin_host_free.
MarginHostCore *margin_host_new(void);
void margin_host_free(MarginHostCore *core);

// One request (UTF-8 JSON, host/api.rs `Request`) → its answer (UTF-8 JSON, *out_len bytes, not NUL-terminated),
// freed with margin_buffer_free. Null: a null core, request or out_len. One thread at a time per core.
uint8_t *margin_host_call(MarginHostCore *core, const uint8_t *request, size_t len, size_t *out_len);
void margin_buffer_free(uint8_t *ptr, size_t len);

// The layout (host/layout.rs), typed: no JSON, no allocation.
bool margin_layout_plan(const MarginPlacement *placement, MarginEdges *out);
bool margin_layout_tile(const MarginPlacement *placement, MarginRect home, MarginRect *out);
MarginRect margin_layout_fit(MarginRect page, double min_width, double min_height, MarginRect area);
MarginRect margin_layout_cut(MarginRect pane, double min_width, double min_height, MarginRect area, bool end_x, bool end_y);
bool margin_layout_home(const MarginPlacement *placement, MarginRect *out);

// Whether a window of these bounds is a full-screen window's strip for this placement (host/kinds.rs).
bool margin_kinds_is_strip(MarginRect bounds, const MarginPlacement *placement);

#endif
