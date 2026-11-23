// margin-core's hosting core behind a C interface (app/platforms/macos/ffi/src/lib.rs, Rust): what Margin.app's Swift calls
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

typedef struct MarginSize {
    double width;
    double height;
} MarginSize;

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

// Each of x, y, width and height within `within` points, the edge included; the toolbar's room above a full-screen
// window (host/layout.rs).
bool margin_layout_near(MarginRect a, MarginRect b, double within);
double margin_layout_toolbar_room(void);

// Whether a window of these bounds is a full-screen window's strip for this placement; a full-screen window's own
// toolbar strip at its top edge, its height not asked (host/kinds.rs).
bool margin_kinds_is_strip(MarginRect bounds, const MarginPlacement *placement);
bool margin_kinds_toolbar_of(MarginRect bounds, MarginRect window);

// Whether a window covers at least `share` of Margin's sidebar (host/front.rs).
bool margin_front_covers_sidebar(MarginRect bounds, const MarginPlacement *placement, double share);

// When the engine looks again (host/schedule.rs): a wake for something heard (`last` -infinity: none yet); seconds
// until the next look (`active_for` NaN: no activity yet; less than zero: none until an event).
bool margin_schedule_wake_due(double now, double last, bool live_on);
double margin_schedule_next_poll(bool hosting, bool links, bool pending, double active_for);

// Whether a running app is the launch known (host/exits.rs): launch times in seconds, NaN not known.
bool margin_exits_same_launch(double then, double now);

// The hosts' model on a hosting core (host/model.rs, ffi model.rs): a host by its handle, its fields by number
// (host/model.rs `Field`: 0-31 whole numbers and flags, 32-63 times and lengths with NaN none, 64-95 rects, 96-127
// lists of times). Typed, nothing allocated but an add. One thread at a time per core, as margin_host_call.
#define MARGIN_MODEL_NONE UINT32_MAX
uint32_t margin_model_add(MarginHostCore *core, const uint8_t *id, size_t id_len, const uint8_t *app, size_t app_len, int64_t window, int64_t pid);
void margin_model_remove(MarginHostCore *core, uint32_t handle);
int64_t margin_model_get(MarginHostCore *core, uint32_t handle, uint32_t field);
void margin_model_set(MarginHostCore *core, uint32_t handle, uint32_t field, int64_t value);
double margin_model_get_real(MarginHostCore *core, uint32_t handle, uint32_t field);
void margin_model_set_real(MarginHostCore *core, uint32_t handle, uint32_t field, double value);
bool margin_model_get_rect(MarginHostCore *core, uint32_t handle, uint32_t field, MarginRect *out);
void margin_model_set_rect(MarginHostCore *core, uint32_t handle, uint32_t field, const MarginRect *value); // NULL: none
size_t margin_model_times(MarginHostCore *core, uint32_t handle, uint32_t field, double *out, size_t cap);   // the count; `cap` written at most
void margin_model_set_times(MarginHostCore *core, uint32_t handle, uint32_t field, const double *values, size_t len);

// Each app's windows' minimum, kept per version (host/minimums.rs: minimums.json, its bytes read and written by the
// shell through the loadMinimums/saveMinimums calls), and each host's own. A host's minimum: `of` 0 a pane's (its own,
// else its app's kept one), 1 a target's known one (none in window mode); answers 0 none, 1 known, 2 its app's kept
// one with its process's version not read yet (read it, set it, ask again; unreadable, `out` holds).
void margin_model_set_version(MarginHostCore *core, uint32_t handle, const uint8_t *version, size_t len);
uint8_t margin_model_minimum(MarginHostCore *core, uint32_t handle, uint8_t of, MarginSize *out);
uint8_t margin_model_learn_min(MarginHostCore *core, uint32_t handle, const MarginSize *read); // NULL: said none. 0 same, 1 its own now, 2 say the unread one kept
bool margin_model_remember_min(MarginHostCore *core, uint32_t handle, const uint8_t *version, size_t len); // NULL: unread ("?"). True: new, save it
void margin_model_held(MarginHostCore *core, uint32_t handle, double width);
double margin_model_learn_from_leaving(MarginHostCore *core, uint32_t handle); // the width taken; NaN none
bool margin_minimums_has(MarginHostCore *core, const uint8_t *app, size_t len);
bool margin_minimums_known(MarginHostCore *core, const uint8_t *app, size_t app_len, const uint8_t *version, size_t version_len, MarginSize *out); // version NULL: not known

// The layout of Margin's page area and its decisions (host/model/visible.rs, ffi visible.rs): typed (read dozens of
// times an operation and every poll); ids as UTF-8 bytes (NULL: none), hosts by handle (MARGIN_MODEL_NONE: none).
// A layout's start and its refusals are JSON (margin_host_call: layoutRefuse, layoutBegin; `layout`, `configure`).
// A decision on the one shown answers -2 leave it, -1 none shown, else the host to show (through the shell's setter).
typedef struct MarginVisible {
    MarginRect rect;
    bool has_rect; // false: the page area
    uint8_t role;  // 0 main, 1 pane, 2 card
    int64_t z;     // back to front, 0 the backmost
} MarginVisible;
void margin_model_list(MarginHostCore *core, const uint8_t *id, size_t len, uint32_t handle); // the engine holds it as `id` (NONE: none)
bool margin_model_layout_get(MarginHostCore *core, const uint8_t *id, size_t len, MarginVisible *out);
void margin_model_layout_set(MarginHostCore *core, const uint8_t *id, size_t len, const MarginVisible *v); // NULL: out of it
size_t margin_model_layout_count(MarginHostCore *core);
uint64_t margin_model_generation(MarginHostCore *core); // counts the layout's changes
void margin_model_layout_move(MarginHostCore *core, const uint8_t *id, size_t len, MarginRect rect);
void margin_model_set_shown(MarginHostCore *core, const uint8_t *id, size_t len, double now); // the layout follows
double margin_model_shown_at(MarginHostCore *core);
void margin_model_set_focus(MarginHostCore *core, const uint8_t *id, size_t len);
void margin_model_placement(MarginHostCore *core, MarginPlacement *out);
void margin_model_set_placement(MarginHostCore *core, const MarginPlacement *p);
bool margin_model_applying(MarginHostCore *core);
bool margin_model_is_visible(MarginHostCore *core, const uint8_t *id, size_t len);
size_t margin_model_visible(MarginHostCore *core, uint32_t *out, size_t cap); // back to front; the count, `cap` written at most
uint32_t margin_model_main_host(MarginHostCore *core);
bool margin_model_alone(MarginHostCore *core, const uint8_t *id, size_t len);
void margin_model_page_of(MarginHostCore *core, uint32_t handle, MarginRect *out);
void margin_model_placement_for(MarginHostCore *core, uint32_t handle, MarginPlacement *out);
uint8_t margin_model_rank(MarginHostCore *core, const uint8_t *id, size_t len); // 0 shown, 1 visible, 2 the rest
uint32_t margin_model_before(MarginHostCore *core, const uint8_t *id, size_t len);
uint8_t margin_model_below_minimum(MarginHostCore *core, uint32_t handle, const MarginRect *rect); // bit 0 below, bit 1 its version wanted
double margin_model_shown_min_width(MarginHostCore *core); // NaN: none
int64_t margin_model_settle_begin(MarginHostCore *core); // -2 nothing settled (a layout applied), -1 none to show, else the host
uint32_t margin_model_settle_focus(MarginHostCore *core);
bool margin_model_hold(MarginHostCore *core, const uint8_t *id, size_t len, uint8_t kind); // 0 one host's placing, 1 a page area's change
int64_t margin_model_release(MarginHostCore *core);
size_t margin_model_layout_relay_held(MarginHostCore *core, uint32_t *out, size_t cap);
uint32_t margin_model_layout_end_alone(MarginHostCore *core);
int64_t margin_model_layout_focus(MarginHostCore *core, const uint8_t *focused, size_t focused_len, const uint8_t *main, size_t main_len);
// bringIn's decision at `point` (0 start, 1 take, 2 route, 3 placed), the shell's facts as bits (1 new, 2 an app's,
// 4 taken, 8 retrying, 16 made ready out of sight): 0 go on, 1 reopen, 2 take, 3 full screen again, 4 window mode,
// 5 placed again, 6 its tile sized first, 7 switched in, 8 placed for another page area, 9 placed full screen.
uint8_t margin_model_bring_in(MarginHostCore *core, uint32_t handle, uint8_t point, uint32_t facts);
// A window-mode window's frame (host/layout.rs): centred at whole points; its frame from where it is (false: there
// already); where it should be.
MarginRect margin_layout_inside(MarginRect page, double width, double height);
bool margin_layout_window_frame(MarginRect page, MarginRect now, bool resizable, bool placed_before, double tolerance, MarginRect *out);
bool margin_layout_at_page_area(MarginRect bounds, MarginRect area, double tolerance);

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
// TCP connection, 1: a relay's; copied before it returns). Answers (JSON) freed with margin_buffer_free. Each link's
// state is mirrored in the core.
typedef struct MarginLink MarginLink;
typedef void (*MarginLinkWrite)(void *ctx, uint8_t which, uint64_t conn, const uint8_t *bytes, size_t len);

MarginLink *margin_link_new(const uint8_t *config, size_t len, void *ctx, MarginLinkWrite write);
void margin_link_free(MarginLink *link);
uint8_t *margin_link_call(MarginLink *link, const uint8_t *request, size_t len, size_t *out_len);
uint8_t *margin_link_bytes(MarginLink *link, uint8_t which, uint64_t conn, const uint8_t *bytes, size_t len, double now, double wall, size_t *out_len);
// One stored key of a link's state (the core mirrors each link's snapshot and deltas: the bytes' answer says only what
// changed), its JSON's bytes as kept; NULL: no such link or key.
uint8_t *margin_link_state_value(MarginLink *link, uint64_t conn, const uint8_t *key, size_t len, size_t *out_len);
uint8_t *margin_link_protocol(const uint8_t *request, size_t len, size_t *out_len);

// The themes a person imported, the built-ins' packages, what the picker chose (data/themes.rs, ffi themes.rs). The
// store: one object over its folder, one JSON call (list, has, save, remove), the package a window draws typed (its
// UTF-8 JSON's bytes, NULL: none). The built-ins: one object over the app's folder (NULL: none), the package typed.
// No object: the id rule, the limits, the picker's choice read within its caps. Freed with margin_buffer_free.
typedef struct MarginThemes MarginThemes;
typedef struct MarginBuiltinThemes MarginBuiltinThemes;

MarginThemes *margin_themes_new(const uint8_t *root, size_t len);
void margin_themes_free(MarginThemes *themes);
uint8_t *margin_themes_call(MarginThemes *themes, const uint8_t *request, size_t len, size_t *out_len);
uint8_t *margin_themes_message(MarginThemes *themes, const uint8_t *id, size_t len, size_t *out_len);
MarginBuiltinThemes *margin_builtin_themes_new(const uint8_t *root, size_t len);
void margin_builtin_themes_free(MarginBuiltinThemes *builtins);
uint8_t *margin_builtin_themes_message(MarginBuiltinThemes *builtins, const uint8_t *chosen, size_t len, size_t *out_len);
uint8_t *margin_themes_protocol(const uint8_t *request, size_t len, size_t *out_len);

#endif
