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
MarginRect margin_layout_cut(MarginRect pane, double min_width, double min_height, MarginRect area, MarginRect page, int8_t end_x, int8_t end_y);
MarginRect margin_layout_within(MarginRect frame, MarginRect area);
bool margin_layout_home(const MarginPlacement *placement, MarginRect *out);

// Whether a window of these bounds is a full-screen window's strip for this placement (host/kinds.rs).
bool margin_kinds_is_strip(MarginRect bounds, const MarginPlacement *placement);

// Margin's keys (shortcuts.rs, ffi keys.rs): combinations as the Mac's Carbon key code and modifier bits. The JSON
// answers are freed with margin_buffer_free; a press, a release and a repeat's tick are typed.
typedef struct {
    bool ok;
    uint16_t key_code;
    uint32_t modifiers;
} MarginKeyCombo;

typedef struct {
    uint8_t kind;  // 0 nothing, 1 one of Margin's keys, 2 the quit guard, 3 a hosted app's key
    uint8_t index; // into the constants' commands; the quit guard: 1 keeps the windows; into appKeys
    bool repeat;   // a held key's repeat
} MarginKeyHit;

typedef struct MarginKeys MarginKeys;
typedef bool (*MarginKeyRegister)(void *ctx, uint32_t id, uint16_t key_code, uint32_t modifiers);
typedef void (*MarginKeyUnregister)(void *ctx, uint32_t id);

MarginKeyCombo margin_keys_parse(const uint8_t *text, size_t len);
uint8_t *margin_keys_describe(uint16_t key_code, uint32_t modifiers, size_t *out_len);
uint8_t *margin_keys_bindings(const uint8_t *keys_json, size_t len, size_t *out_len);
uint8_t *margin_keys_held(const uint8_t *bindings_json, size_t len, bool margin_in_front, bool browser, int32_t spaces, int32_t items, size_t *out_len);
uint8_t margin_keys_gate(int64_t front_pid, int64_t own_pid, bool front_hosted, bool window_open, bool on_current_space, bool asks, bool quitting);
bool margin_keys_is_browser_app(const uint8_t *bundle, size_t len, const uint8_t *linked_json, size_t linked_len);
bool margin_keys_is_chromium(const uint8_t *bundle, size_t len);
uint8_t *margin_keys_constants(size_t *out_len);
MarginKeys *margin_keys_new(void *ctx, MarginKeyRegister reg, MarginKeyUnregister unreg);
void margin_keys_free(MarginKeys *keys);
uint8_t *margin_keys_rebind(MarginKeys *keys, const uint8_t *bindings_json, size_t len, size_t *out_len);
uint8_t *margin_keys_set_active(MarginKeys *keys, bool active, size_t *out_len);
uint8_t *margin_keys_set_quit_guard(MarginKeys *keys, bool active, size_t *out_len);
uint8_t *margin_keys_set_app_key_guard(MarginKeys *keys, bool active, size_t *out_len);
MarginKeyHit margin_keys_press(MarginKeys *keys, uint32_t id, double now, double delay, double interval);
void margin_keys_release(MarginKeys *keys, uint32_t id);
double margin_keys_next_tick(MarginKeys *keys);
MarginKeyHit margin_keys_tick(MarginKeys *keys, double now, uint32_t modifiers_down);
uint8_t *margin_keys_state(MarginKeys *keys, size_t *out_len);

// The lasting data (data/, ffi data.rs): the profiles' sync and the app's library, each one JSON call; their stores
// write on a thread of their own and call `wake` there after each save (hop to the main thread, then `written`). The
// choice for a profile with no set: `need` gets the question as JSON and answers JSON allocated with malloc (or NULL:
// ask), freed by the data object with free.
typedef struct MarginData MarginData;
typedef struct MarginLibrary MarginLibrary;
typedef void (*MarginDataWake)(void *ctx);
typedef uint8_t *(*MarginDataNeed)(void *ctx, const uint8_t *question, size_t len, size_t *out_len);

MarginData *margin_data_new(const uint8_t *root, size_t len, bool background, void *ctx, MarginDataWake wake, MarginDataNeed need);
void margin_data_free(MarginData *data);
uint8_t *margin_data_file_name(const uint8_t *name, size_t len, size_t *out_len);
uint8_t *margin_data_call(MarginData *data, const uint8_t *request, size_t len, size_t *out_len);
MarginLibrary *margin_library_new(const uint8_t *root, size_t len, bool background, void *ctx, MarginDataWake wake);
void margin_library_free(MarginLibrary *library);
uint8_t *margin_library_call(MarginLibrary *library, const uint8_t *request, size_t len, size_t *out_len);

// A browser's profiles (data/profiles.rs, ffi profiles.rs; the hosted file's shape): one object per browser over its
// browser.json in `root` (NULL: in memory), one JSON call (`now` passed in, the log lines in each answer), and the
// slots rule on its own. Answers freed with margin_buffer_free.
typedef struct MarginProfiles MarginProfiles;

MarginProfiles *margin_profiles_new(const uint8_t *browser, size_t browser_len, const uint8_t *root, size_t root_len);
void margin_profiles_free(MarginProfiles *profiles);
uint8_t *margin_profiles_call(MarginProfiles *profiles, const uint8_t *request, size_t len, size_t *out_len);
uint8_t *margin_profiles_resolve(const uint8_t *request, size_t len, size_t *out_len);

// The link (link_hub.rs, ffi link.rs): the copies' WebSockets, Chrome's and Edge's relays, Safari's way in. The Swift
// side owns the sockets, Safari's dispatch, the notification, the note's file and one timer, and carries out each
// answer's `do` list in order. Bytes in are typed; bytes out come through `write` during the call (which 0: a copy's
// TCP connection, 1: a relay's; copied before it returns). Answers (JSON) freed with margin_buffer_free.
typedef struct MarginLink MarginLink;
typedef void (*MarginLinkWrite)(void *ctx, uint8_t which, uint64_t conn, const uint8_t *bytes, size_t len);

MarginLink *margin_link_new(const uint8_t *config, size_t len, void *ctx, MarginLinkWrite write);
void margin_link_free(MarginLink *link);
uint8_t *margin_link_call(MarginLink *link, const uint8_t *request, size_t len, size_t *out_len);
uint8_t *margin_link_bytes(MarginLink *link, uint8_t which, uint64_t conn, const uint8_t *bytes, size_t len, double now, double wall, size_t *out_len);
uint8_t *margin_link_protocol(const uint8_t *request, size_t len, size_t *out_len);

#endif
