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
// The budgets of Margin's own corrections (host/model/budget.rs): kind 0 a stray's returns, 1 a re-entry into full
// screen, 2 off screen in place, 3 off screen elsewhere, 4 a cut pane's repair. 0 go, 1 spent (say it), 2 spent
// (said already), 3 spent (say it: its streak), 4 held by the loop guard's per-second hold (`guarded`), nothing spent,
// `until` when it lapses; `count` NULL or the budget's entries. The full-screen ladder per host.
uint8_t margin_budget_spend(MarginHostCore *core, uint32_t handle, uint8_t kind, double now, bool guarded, uint32_t *count, double *until);
uint32_t margin_budget_repair_took(MarginHostCore *core, uint32_t handle, bool took); // the ones in a row that didn't take
void margin_budget_cut_order_right(MarginHostCore *core, uint32_t handle);
bool margin_model_full_screen_failed(MarginHostCore *core, uint32_t handle); // true: tried again at its next show
void margin_model_adopted(MarginHostCore *core, uint32_t handle, bool can_full_screen);
void margin_model_moved_to_window(MarginHostCore *core, uint32_t handle);
// The poll and its looks (host/model/watch.rs), per host: a place is 0 unread, 1 in no Space, 2 in Margin's Space
// alone, 3 elsewhere. poll_read: read 0 closed by its app, 1 unread, 2 read -> 0 gone, 1 skip, 2 read. poll_gone: runs
// -1 not read -> 0 read it and ask again, 1 nothing, 2 reopen at its next show, 3 the one shown's, 4 gone as any.
// stray: 0 nothing, 1 park, 2 park alone (count), 3 bring back. off_screen: 0 in place, 1/2 in place spent (say/said),
// 4/5 given up (say/said, count), 6 held (until), 8 + 1 make Margin's Space current + 2 move its window in.
uint8_t margin_watch_poll_read(MarginHostCore *core, uint32_t handle, uint8_t read);
uint8_t margin_watch_poll_gone(MarginHostCore *core, uint32_t handle, double now, int8_t runs, bool parked_own);
bool margin_watch_poll_place(MarginHostCore *core, uint32_t handle, uint8_t place, bool margin_here);
uint8_t margin_watch_stray(MarginHostCore *core, uint32_t handle, double now, uint8_t place, bool margin_here, bool margin_now, uint32_t *count);
bool margin_watch_still_off(bool margin_on, bool host_on, int8_t own_on); // own_on -1: not read yet
uint8_t margin_watch_off_screen(MarginHostCore *core, uint32_t handle, double now, bool margin_on, bool host_on, bool current_is_margin, uint8_t place, bool guarded, uint32_t *count, double *until);
// A host's close (host/close.rs): one decision by point with the host's facts as bits (host/close.rs `Facts`, in
// order), exit 0 waited 1 watched 2 at quit, quits, and the point's own flag (closed: 5, 6, 8; in Margin's Space: 7, 10).
// Points: 0 quit at once, 1 freeze, 2 give back (0 nothing, 1 frame, 2 out of full screen), 3 quits, 4 close button
// asked, 5 home after, 6 before the quit matters, 7 before the quit (0, 1 home, 2 out of sight), 8 a copy's window to
// the Desktop, 9 left to the person, 10 the marker keeps it (0, 1, 2 as a member). The apps a row's close asked to
// quit (host/exits.rs): their reads typed, their changes JSON.
uint8_t margin_close_decide(uint8_t point, uint8_t exit, uint32_t facts, bool quits, bool flag);
bool margin_exits_same_marked_launch(double then, double now); // NaN: unknown
bool margin_exits_asked(MarginHostCore *core, int64_t pid, const uint8_t *bundle, size_t bundle_len, double launched_at, const uint8_t *id, size_t id_len, double at); // launched_at NaN: unknown
bool margin_exits_exited(MarginHostCore *core, int64_t pid); // false: none asked
uint8_t margin_exits_take_back(MarginHostCore *core, int64_t pid, bool running, const uint8_t *bundle, size_t len, double launched_at); // 0 none, 1 exited unheard, 2 back
bool margin_exits_has(MarginHostCore *core, int64_t pid);
size_t margin_exits_count(MarginHostCore *core);
double margin_exits_asked_at(MarginHostCore *core, int64_t pid); // NaN: none
double margin_exits_launched_at(MarginHostCore *core, int64_t pid); // NaN: none, or unknown
size_t margin_exits_overdue(MarginHostCore *core, double now, double quit_wait, int64_t *out, size_t cap);
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

// Where each visible host's window goes and cut panes (host/model/panes.rs, ffi panes.rs): typed (`frame` per follower
// per frame of a drag). A placement NULL: the host's own. Each reading call notes the hosts whose minimum it read as
// their app's kept one with their process's version unread (margin_model_versions_wanted, right after it: read each
// one's version, set it, ask again). Sides: 0 left, 1 right, 2 up, 3 down; as bits 1, 2, 4, 8.
typedef struct MarginSlide {
    MarginRect pane;
    int8_t end_x; // 0 its start at the pane's, 1 its end, -1 away from the other panes
    int8_t end_y;
} MarginSlide;
void margin_model_set_live_page(MarginHostCore *core, const MarginRect *page); // a drag's page area; NULL: none
size_t margin_model_versions_wanted(MarginHostCore *core, uint32_t *out, size_t cap);
void margin_model_frame(MarginHostCore *core, uint32_t handle, const MarginPlacement *p, MarginRect *out);
void margin_model_fitted(MarginHostCore *core, uint32_t handle, const MarginPlacement *p, bool entry, MarginPlacement *out); // entry: as its own Space reserves it
bool margin_model_tile_rect(MarginHostCore *core, uint32_t handle, const MarginPlacement *p, MarginRect home, MarginRect *out);
bool margin_model_is_cut(MarginHostCore *core, uint32_t handle);
int8_t margin_model_cut(MarginHostCore *core, uint32_t handle); // -1 not cut, else its sides' bits
bool margin_model_slide_for(MarginHostCore *core, uint32_t handle, uint8_t side, MarginSlide *out);
size_t margin_model_lying_under(MarginHostCore *core, uint32_t handle, const MarginRect *at, uint32_t *out, size_t cap); // at NULL: its frame
bool margin_model_tucked(MarginHostCore *core, uint32_t handle, const MarginRect *at);
bool margin_model_over_under(MarginHostCore *core, uint32_t handle, const int64_t *front_to_back, size_t n);
// The visible windows' order (host/model/order.rs, ffi order.rs): the plan JSON (margin_host_call: frontPlan, once a
// fronting); the order wanted, the window server's order of those windows and the focused one's check while it's
// waited for, typed. Window numbers back to front as wanted; on-screen lists front to back (NULL: unread).
size_t margin_model_front_wanted(MarginHostCore *core, uint32_t *out, size_t cap);
int64_t margin_order_server(const int64_t *windows, size_t n, const int64_t *screen, size_t m, int64_t *out, size_t cap); // -1: unread
bool margin_order_top_behind(const int64_t *windows, size_t n, const uint32_t *below, size_t k, const int64_t *screen, size_t m);
uint8_t margin_model_slide_step(MarginHostCore *core, MarginRect from, MarginRect to, double elapsed, double time, const MarginRect *home, MarginRect *page, MarginRect *tile); // bits: 1 last, 2 tile written

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
