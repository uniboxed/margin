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
double margin_guard_held_until(MarginHostCore *core, double now); // the loop guard's hold in force ends then; NaN: none
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
void margin_model_set_live_page(MarginHostCore *core, const MarginRect *page); // a drag's page area; NULL: none (the drag's own: margin_live_follow)
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

// Margin's own window's page (core/page/, passthrough.rs PagePointer, ffi page.rs; docs/CORE-REFACTOR.md step 3 parts
// 11-12): one object per Margin window, the main thread's. Its pointer: the slot and catch region (placed from its own
// holes, margin_page_place_hole), the theme's window buttons, the positions its page wants, the cut panes, each pointer
// event's way; typed, nothing allocated. The views' rects are the page's own until its next placing. margin_pass_*:
// the same rules (CGRect's edges) over a slot the caller holds, no object, any thread (the pane click tap's).
typedef struct MarginPoint {
    double x;
    double y;
} MarginPoint;

typedef struct MarginInsets {
    double left;
    double top;
    double right;
    double bottom;
    double radius;
} MarginInsets;

typedef struct MarginSlotView {
    MarginRect rect;
    double radius;
    const MarginRect *hits;
    size_t hits_len;
    bool capture_all;
    bool has_holes; // several visible hosts: the pointer through these only
    const MarginRect *holes;
    size_t holes_len;
} MarginSlotView;

typedef struct MarginCatchView {
    bool all;
    bool has_hole;
    MarginRect hole;
    double radius;
    const MarginRect *hits;
    size_t hits_len;
    bool has_holes;
    const MarginRect *holes;
    size_t holes_len;
} MarginCatchView;

typedef struct MarginCut {
    int64_t window;
    MarginRect rect;
    bool cut; // one of the cut panes
} MarginCut;

typedef struct MarginPointer {
    bool pass;       // the panel lets the pointer through (ignores the mouse)
    bool inside;     // over the content
    bool hover_said; // the cut pane under it changed: has_hover and hover the new one's window
    bool has_hover;
    int64_t hover;
    uint8_t push;    // 0 nothing, 1 the position (pointer), 2 it left (pointerLeft), at x, y in the content
    double x;
    double y;
} MarginPointer;

typedef struct MarginPage MarginPage;
MarginPage *margin_page_new(void);
void margin_page_free(MarginPage *page);
void margin_page_set_pointer_every(MarginPage *page, double every);
bool margin_page_slot(const MarginPage *page, MarginSlotView *out); // false: none
void margin_page_catch(const MarginPage *page, MarginCatchView *out);
void margin_page_set_buttons(MarginPage *page, const MarginRect *controls, bool full_screen); // controls in the content, NULL: none
void margin_page_set_want(MarginPage *page, uint8_t mode, uint8_t edges, double zone); // mode 0 none, 1 edges, 2 all; edges' bits 1 left, 2 right, 4 top, 8 bottom
bool margin_page_set_cuts(MarginPage *page, bool cutting, const MarginCut *list, size_t len); // true: the hovered cut pane forgotten
void margin_page_pointer(MarginPage *page, MarginPoint at, MarginRect content, bool buttons_down, double now, MarginPointer *out);
bool margin_page_pointer_again(MarginPage *page, MarginPoint at, MarginRect content);
bool margin_page_gets(const MarginPage *page, MarginPoint at);
bool margin_page_ignoring(const MarginPage *page);
bool margin_pass_page_gets(MarginPoint at, const MarginSlotView *slot); // slot NULL: none
bool margin_pass_decide(MarginPoint at, const MarginSlotView *slot, bool buttons_down, bool ignoring);
MarginRect margin_pass_slot(MarginRect frame, MarginInsets layout, const MarginRect *hits, size_t hits_len, MarginRect *hits_out);
void margin_pass_catch(MarginRect frame, const MarginSlotView *slot, MarginRect *hits_out, MarginRect *holes_out, MarginCatchView *out); // room for the slot's counts
bool margin_pass_catch_contains(const MarginCatchView *region, MarginPoint p, double width, double height);
bool margin_pass_wants(uint8_t mode, uint8_t edges, double zone, MarginPoint p, double width, double height);

// The live-resize pump's scheduling (host/model/live.rs, ffi live.rs): a drag's start and end, each page frame (its
// page area the drag's, for `frame`), each tick of the pump (the flights' landings read first: margin_live_reads),
// each send (asked again after a version is read, as the calls above) and the tick's end; typed, nothing allocated.
// Lists hold 16 (the most hosts a drag moves). The engine keeps every write, read and sleep, and the drag's numbers.
typedef struct MarginLiveTiming {
    double frame;     // at most one change a host this often (liveFrame)
    double wait;      // a change not landed after this long given up (liveWait)
    double tolerance; // landed this near its rect
} MarginLiveTiming;
typedef struct MarginLiveRead {
    uint32_t host;
    int64_t window;
} MarginLiveRead;
typedef struct MarginLiveBounds {
    uint32_t host;
    bool read; // false: unread
    MarginRect bounds;
} MarginLiveBounds;
typedef struct MarginLiveEvent {
    uint32_t host;
    bool landed;    // false: given up after the wait
    double elapsed; // landed: since it was sent
} MarginLiveEvent;
typedef struct MarginLiveTick {
    bool go;         // false: nothing sent (held: a frame owed; stop: the pump ends, else it sleeps a frame)
    bool held;
    bool stop;
    bool owed_empty; // go: every follower sent the frame
    uint32_t shown;  // go: the one shown
    MarginPlacement frame; // go: the frame sent
    size_t events;
    size_t sends;
} MarginLiveTick;
typedef struct MarginLiveSend {
    uint8_t kind; // 0 nothing, 1 its tile's rect (its window lands at page), 2 its window's frame page
    bool centred; // kind 2: a fixed-size window centred in it at its own size
    MarginRect rect;
    MarginRect page;
} MarginLiveSend;
bool margin_live_on(MarginHostCore *core);
int32_t margin_live_start(MarginHostCore *core, double now, bool quitting, uint32_t *others, size_t cap); // -1: not followed
bool margin_live_end(MarginHostCore *core);
bool margin_live_follow(MarginHostCore *core, double now, const MarginPlacement *p);
void margin_live_hold(MarginHostCore *core);
bool margin_live_forgotten(MarginHostCore *core, double now, double forget);
size_t margin_live_followers(MarginHostCore *core, size_t *visible);
void margin_live_pump_begin(MarginHostCore *core);
size_t margin_live_reads(MarginHostCore *core, MarginLiveRead *out, size_t cap);
void margin_live_tick(MarginHostCore *core, double now, const MarginLiveTiming *timing, const MarginLiveBounds *reads, size_t n, bool busy, bool quitting, MarginLiveEvent *events, size_t events_cap, uint32_t *sends, size_t sends_cap, MarginLiveTick *out);
void margin_live_send(MarginHostCore *core, uint32_t handle, const MarginPlacement *p, const MarginRect *given, const MarginRect *home, MarginLiveSend *out);
void margin_live_sent(MarginHostCore *core, uint32_t handle, double at, MarginRect want);
bool margin_live_done(MarginHostCore *core);

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
// The library (margin-core's library object, ffi data.rs: its store and its rules, the person's sorter: libicucore's
// collation for JSC's default locale). Its callbacks, called during a call and free to call back in: `env` (an action's
// time in ms, answered, and its ids, each given through margin_library_env_id), `now` (its changes' time), `changed`
// (the collections an edit changed, a JSON array); each NULL: the wall clock, 4 random ids, no observer. `call`:
// values (a `collection`'s, or all), apply, written, rev; perform (its requests to the session made over it, its sink,
// inside the call), snapshot, actions, item, requests, imported (each with `log`). `import`: the import once over the
// data object's sets (read first). `rules`: library.js's `marginLibrary.call(name, argsJSON)` answered by the core (the
// library's sorter; NULL: the person's), for the tests: the shared vectors with the Mac's sorter.
typedef struct MarginLibraryEnvOut MarginLibraryEnvOut;
typedef double (*MarginLibraryEnv)(void *ctx, MarginLibraryEnvOut *out);
typedef double (*MarginLibraryNow)(void *ctx);
typedef void (*MarginLibraryChanged)(void *ctx, const uint8_t *collections, size_t len);
MarginLibrary *margin_library_new(const uint8_t *root, size_t len, bool background, void *ctx, MarginDataWake wake, MarginLibraryEnv env, MarginLibraryNow now, MarginLibraryChanged changed);
void margin_library_free(MarginLibrary *library);
void margin_library_env_id(MarginLibraryEnvOut *out, const uint8_t *id, size_t len);
uint8_t *margin_library_call(MarginLibrary *library, const uint8_t *request, size_t len, size_t *out_len);
uint8_t *margin_library_import(MarginLibrary *library, MarginData *data, size_t *out_len);
uint8_t *margin_library_rules(MarginLibrary *library, const uint8_t *name, size_t name_len, const uint8_t *args, size_t args_len, size_t *out_len);
// The theme of the space a Margin window shows (its own space's, else the first's), typed (a draw's): its length (over
// `cap`: ask again), -1: none (the profile's).
ptrdiff_t margin_library_space_theme(const MarginLibrary *library, int64_t window, uint8_t *buf, size_t cap);
// The appearance of the space a Margin window shows (its background's, the space found as its theme is): 1 light,
// 2 dark, 0 none (the system's).
int32_t margin_library_space_appearance(const MarginLibrary *library, int64_t window);

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
// Which of a connection's copy's windows Margin draws (session/route.rs `drawn`): `hosted` the session's, `windows`
// the copy's as listed; each change told the copy, what it was told kept per connection. NULL when nothing was sent,
// else the answer as `send`'s (its `do` list, `refused`).
uint8_t *margin_link_drawn(MarginLink *link, uint64_t conn, const uint8_t *epoch, size_t epoch_len, const int64_t *hosted, size_t hosted_len, const int64_t *windows, size_t windows_len, double now, double wall, size_t *out_len);
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

// The session (session/, ffi session.rs: HostedSession's flows as async steps): one object per app over the library
// object (the library's requests' sink from `new` on, or from `take_requests`, of several over one library: they reach
// it inside a perform; a perform Swift makes itself is followed by the `edited` input, which answers what they left),
// with the Swift side's ports, called during a call and free to call back in: `now` (the monotonic clock) and
// `port` (JSON in, JSON out allocated with malloc or NULL, freed by the session with free). `input`, `answer` (a
// command's, by its id) and `tick` (the commands handed out are started, the deadlines up to `due` over) each answer
// `{ start?, deadline, log?, reply?, error? }`: start each command at once, in order, then call `tick`. Answers freed
// with margin_buffer_free. `rev`: a field's revision (session/state.rs `Field`: 0 shown, 1 open, 2 safariWindows,
// 3 done, 4 requested ... 17 made, 18 cards … 23 revealHeld, 24 elsewhere, 25 resume, 26 resuming, 27 start). Typed, nothing allocated: `link_wanted` (a show waiting on a profile's link still
// wanted: the Safari waker's look) and `open_wanted` (a new app's open for an item in a Margin window still wanted:
// the engine's); `prepare_wanted` (the waker's look for the launch's preparation) and `start_screen` (the start
// screen up: read per key press); `ready`: tasks ready to run (a field's edit woke one). `settle`: hosting settled (HostedSession `settleHosting`), answered as `input`.
// The typed ports (`call`, by their number: ffi session.rs `PortKind`, SessionCore.swift's) answer a number
// (INT64_MIN: none) and give their texts and lists back through margin_port_out_text / _int during the call. Given a
// MarginSessionStatus, `input`, `answer` and `tick` write their readiness and deadline (NaN: none) there and answer
// JSON only when there's more (else NULL). The facade's fields typed: `rows` (each to a sink, its texts valid during
// the call) and `edit_row`.
typedef struct MarginSession MarginSession;
typedef struct MarginPortOut MarginPortOut;
typedef struct MarginBytes { const uint8_t *ptr; size_t len; } MarginBytes;
typedef struct MarginPortArgs { int64_t window; bool has_window; bool flag; MarginBytes a; MarginBytes b; MarginBytes c; } MarginPortArgs;
typedef struct MarginSessionStatus { bool ready; double deadline; } MarginSessionStatus;
typedef struct MarginRow { int64_t i0; double f; bool b0; bool b1; MarginBytes s0; MarginBytes s1; MarginBytes s2; } MarginRow;
typedef double (*MarginSessionNow)(void *ctx);
typedef uint8_t *(*MarginSessionPort)(void *ctx, const uint8_t *ask, size_t len, size_t *out_len);
typedef int64_t (*MarginSessionCall)(void *ctx, uint32_t kind, const MarginPortArgs *args, MarginPortOut *out);
typedef void (*MarginRowSink)(void *ctx, const MarginRow *row);

MarginSession *margin_session_new(MarginLibrary *library, const uint8_t *options, size_t len, void *ctx, MarginSessionNow now, MarginSessionPort port, MarginSessionCall call);
void margin_session_free(MarginSession *session);
void margin_session_take_requests(MarginSession *session);
void margin_port_out_text(MarginPortOut *out, const uint8_t *ptr, size_t len);
void margin_port_out_int(MarginPortOut *out, int64_t n);
void margin_port_out_float(MarginPortOut *out, double n);
// Layouts and the page area moving (step 3 commit 6): `drag` (the Margin window whose sidebar's edge is dragged, -1
// none, and whether the one shown follows it). The hot path, `page_rect`: each change of a Margin window's page area
// (every frame of a drag), its page read in the core (NULL: through the ports), where it draws the preview card's page
// (NULL: none): 0 nothing, 1 a drag's frame followed (through `follow`, set with `set_follow`: the page area
// and the other visible hosts' rects, their ids the session's for the call's length), 2 a placing queued (tick in the
// next turn). Nothing allocated, no JSON. Field 18: layouts (read as JSON, `state`).
typedef struct MarginHostRect {
    const uint8_t *host;
    size_t len;
    MarginRect rect;
} MarginHostRect;
typedef void (*MarginSessionFollow)(void *ctx, const MarginPlacement *placement, const MarginHostRect *rects, size_t n);
void margin_session_set_follow(const MarginSession *session, MarginSessionFollow follow);
uint8_t margin_session_page_rect(const MarginSession *session, int64_t window, const MarginPage *page, MarginRect content, const MarginRect *display, const MarginRect *card);
void margin_session_drag(const MarginSession *session, int64_t *window, bool *following);
uint8_t *margin_session_input(const MarginSession *session, const uint8_t *input, size_t len, MarginSessionStatus *status, size_t *out_len);
uint8_t *margin_session_answer(const MarginSession *session, uint64_t id, const uint8_t *reply, size_t len, MarginSessionStatus *status, size_t *out_len);
uint8_t *margin_session_tick(const MarginSession *session, double due, MarginSessionStatus *status, size_t *out_len);
void margin_session_rows(const MarginSession *session, uint32_t field, void *ctx, MarginRowSink sink);
bool margin_session_edit_row(const MarginSession *session, uint32_t field, bool del, const MarginRow *row, uint64_t *rev);
uint8_t *margin_session_done(const MarginSession *session, size_t *out_len);
bool margin_session_idle(const MarginSession *session);
uint64_t margin_session_rev(const MarginSession *session, uint32_t field);
bool margin_session_link_wanted(const MarginSession *session, const uint8_t *profile, size_t len);
bool margin_session_open_wanted(const MarginSession *session, int64_t window, const uint8_t *item, size_t len);
// Whether an item is a pin's or a favourite's tab (the card's auto-preview, told with each hostShow): typed, no JSON
// (Swift's applyLayout asks it for each web pane).
bool margin_session_pinned(const MarginSession *session, const uint8_t *item, size_t len);
// A page's click for a preview (the copy's `peekOpen`), typed: its id and address (null: none), its time (0: none).
uint8_t *margin_session_peek_open(const MarginSession *session, MarginBytes profile, int64_t window, bool has_window,
                                  MarginBytes id, MarginBytes url, double not_after, MarginSessionStatus *status,
                                  size_t *out_len);
// Step 3's commit 9 (the loading bar, the copies' messages, the UI's numbers and rows), typed; the ones that answer
// as `input` does take a status. `copy_message`: a copy's push as its JSON's bytes, routed by the core (the loading
// bar's, the preview card's, the UI's); `copy_tabs`: a Safari copy's `openTabs` value's bytes. `number` gives an item its
// UI number if it has none; `open_row` INT64_MIN: none; `item_of_tab` its length (-1: none; over `cap`: ask again).
// `state`: what a Margin window draws, one call a draw (the library's kept snapshot with the session's open items as
// tabs, `tail`, the profile's `"settings":…,"favicons":…`, before the last brace; `null` with no library).
uint8_t *margin_session_loading(const MarginSession *session, const uint8_t *host, size_t len, MarginSessionStatus *status, size_t *out_len);
uint8_t *margin_session_refresh_loading(const MarginSession *session, MarginSessionStatus *status, size_t *out_len);
uint8_t *margin_session_copy_message(const MarginSession *session, MarginBytes browser, MarginBytes profile, bool has_window, int64_t window, const uint8_t *msg, size_t len, MarginSessionStatus *status, size_t *out_len);
uint8_t *margin_session_copy_tabs(const MarginSession *session, MarginBytes profile, const uint8_t *state, size_t len, MarginSessionStatus *status, size_t *out_len);
int64_t margin_session_number(const MarginSession *session, const uint8_t *item, size_t len);
int64_t margin_session_open_row(const MarginSession *session, const uint8_t *item, size_t len);
ptrdiff_t margin_session_item_of_tab(const MarginSession *session, int64_t n, uint8_t *buf, size_t cap);
uint8_t *margin_session_state(const MarginSession *session, const uint8_t *tail, size_t tail_len, size_t *out_len);
size_t margin_session_drawn_windows(const MarginSession *session, MarginBytes browser, MarginBytes profile, int64_t *out, size_t cap);
bool margin_session_prepare_wanted(const MarginSession *session);
bool margin_session_start_screen(const MarginSession *session);
bool margin_session_ready(const MarginSession *session);
uint8_t *margin_session_settle(const MarginSession *session, MarginSessionStatus *status, size_t *out_len);

// The session's pure rules (margin-core's session: ffi session_rules.rs), no object: the rare ones by one JSON call
// (`{ rule, … }`: constants, resolve, loaderApp, lastItem, searchUrl, dragLine, pushEmpty), a split's room, the card's
// rect and a web address typed (a web address: 0 no, 1 yes, 2 yes if the OS's IDNA makes a valid name of its host,
// those bytes), a push for the page (the UI's numbers asked through `tab`, negative: none), the page's layout report
// (typed, its texts in the caller's buffer). Answers freed with margin_buffer_free.
typedef struct MarginPaneRoom {
    uint8_t role; // 0 main, 1 a pane, 2 a card
    bool has_rect;
    MarginRect rect;
    bool has_least;
    MarginSize least;
    bool had;
} MarginPaneRoom;
typedef int64_t (*MarginPushTab)(void *ctx, const uint8_t *entry, size_t len);
typedef struct MarginText {
    size_t at; // its bytes in the caller's buffer
    size_t len;
} MarginText;
typedef struct MarginPageLayout {
    double left, top, right, bottom, radius;
    double radii[4];
    double width, height;
    bool outside, hosted;
    MarginText mode;
    uint8_t fill_count; // 0 or 4
    MarginText fills[4];
    bool has_split;
    MarginText split;
    uint8_t pane_count; // 0, or 2 to 4
    MarginText pane_items[4];
    MarginRect pane_rects[4];
} MarginPageLayout;

uint8_t *margin_session_rule(const uint8_t *request, size_t len, size_t *out_len);
bool margin_session_is_no_room(const uint8_t *why, size_t len);
bool margin_session_no_room(const MarginPaneRoom *panes, size_t n, MarginRect page, bool *leave);
MarginRect margin_card_default_rect(MarginRect page);
uint8_t margin_web_address(const uint8_t *s, size_t len, size_t *host_at, size_t *host_len);
uint8_t *margin_push_page(const uint8_t *msg, size_t len, void *ctx, MarginPushTab tab, size_t *out_len);
// The layout report read: the bytes its texts take (more than cap: nothing written), -1: not one.
ptrdiff_t margin_page_layout_read(const uint8_t *geometry, size_t len, MarginPageLayout *out, uint8_t *text, size_t cap);

// The page (core/page/): its page card's state (0 empty, 1 loading, 2 shown, 3 elsewhere) and the loader's grace (a
// deadline: the caller's timer calls margin_page_grace_over then), the holes and the ground, in front of what it hosts,
// the page area from its layout report, the placements. The window server's reads are the caller's, made where it
// made them and handed in first; the outs carried out by the caller in their order. Typed; nothing allocated but a
// layout report's parse (its one JSON). Texts: has false is none; a text's length back (more than cap: not written).
typedef struct MarginRgba {
    double r, g, b, a; // sRGB, 0…1
} MarginRgba;
typedef struct MarginGroundHole {
    MarginRect rect; // in the content
    double radii[4]; // top-left, top-right, bottom-right, bottom-left
    bool has_radii;  // false: square
} MarginGroundHole;
typedef struct MarginShown {
    int64_t window;
    MarginRect rect;
    int64_t z;
    uint8_t role; // 0 main, 1 a pane, 2 the card
    bool focused;
} MarginShown;
typedef struct MarginFrame {
    int64_t window;
    MarginRect rect;
} MarginFrame;
typedef struct MarginPaneHole {
    MarginRect rect;
    int64_t window;
    bool card;
} MarginPaneHole;
typedef struct MarginHolePlaced {
    bool slot, region; // changed: the pointer looked at again, the catch fill drawn again
    uint8_t ground;    // 0 no hole (the panel's background the fill), 1 around hole, 2 around holes
    bool has_fill;     // false: the window's own background
    MarginRgba fill;
    MarginGroundHole hole;
    const MarginGroundHole *holes; // the page's own, until its next placing
    size_t holes_len;
} MarginHolePlaced;
typedef struct MarginSettled {
    bool grace, hole_again; // the grace began (until deadline), its hole placed again meanwhile
    double deadline;
    bool changed, shown;    // else applied: its page told, shown
} MarginSettled;
typedef struct MarginFrontCounts {
    uint64_t level_sets, front_orders, yield_orders, front_restores, level_probes, level_backs;
} MarginFrontCounts;
typedef struct MarginPageRead {
    uint8_t state;
    bool hosting;
    bool has_hosted;
    int64_t hosted;
    bool has_frame;
    MarginRect frame; // the hosted window's bounds as read
    bool has_hole;
    MarginRect hole;
    size_t holes, visible;
    bool following, starting, has_loading, has_showing;
    bool has_ground;
    MarginRgba ground;
    uint8_t mechanism; // 0 its level, 1 its order
    bool has_yielding;
    int64_t yielding;
    bool has_covering;
    int64_t covering;
    bool has_grace;
    double grace_until;
    MarginFrontCounts counts;
} MarginPageRead;
typedef struct MarginKeepFront {
    uint8_t level; // 0 none, 1 normal, 2 raised; then ordered above, then below (in this order)
    bool has_above;
    int64_t above;
    bool has_below;
    int64_t below;
} MarginKeepFront;
typedef struct MarginFrontOp {
    uint8_t kind; // 1 normal level, 2 raised level, 3 above arg; said: 4 hosted above it (arg its mechanism), 5 held, 6 by its order (arg ms), 7 by its level again
    int64_t arg;
} MarginFrontOp;
typedef struct MarginFrontOps {
    MarginFrontOp ops[8];
    uint8_t len;
} MarginFrontOps;
typedef struct MarginPagePanes {
    MarginText split; // texts in the caller's buffer
    uint8_t count;
    MarginText items[4];
    MarginRect rects[4];
} MarginPagePanes;
typedef double (*MarginClock)(void *ctx);
void margin_page_configure(MarginPage *page, double grace, const uint8_t *label, size_t len, bool order, int64_t raised, int64_t normal);
uint8_t margin_page_set_layout(MarginPage *page, const uint8_t *bytes, size_t len); // bits: 1 taken, 2 a split's panes changed
ptrdiff_t margin_page_layout_get(const MarginPage *page, MarginPageLayout *out, uint8_t *text, size_t cap); // -1: none
void margin_page_set_hits(MarginPage *page, const MarginRect *hits, size_t len, bool capture_all);
void margin_page_set_full_screen(MarginPage *page, bool on);
uint8_t margin_page_update(MarginPage *page, MarginRect content, const MarginRect *display, MarginRect *out, double *radius); // 0 as it is, 1 none, 2 out
bool margin_page_hosted_placement(const MarginPage *page, MarginRect content, const MarginRect *display, MarginPlacement *out);
bool margin_page_idle_placement(const MarginPage *page, MarginRect content, MarginPlacement *out);
ptrdiff_t margin_page_panes(const MarginPage *page, MarginRect content, MarginPagePanes *out, uint8_t *text, size_t cap); // -1: none
uint8_t margin_page_set_hosting(MarginPage *page, bool on); // 0 no change; bits 1 changed, 2 several were visible
bool margin_page_set_loading(MarginPage *page, const uint8_t *label, size_t label_len, bool has_label, const uint8_t *app, size_t app_len, bool has_app);
bool margin_page_set_showing(MarginPage *page, const uint8_t *label, size_t label_len, bool has_label, const uint8_t *app, size_t app_len, bool has_app, bool slow);
bool margin_page_set_elsewhere(MarginPage *page, const uint8_t *label, size_t label_len, bool has_label, const uint8_t *app, size_t app_len, bool has_app);
bool margin_page_set_stuck(MarginPage *page, const uint8_t *why, size_t len, bool has);
uint8_t margin_page_set_hosted(MarginPage *page, bool has, int64_t number); // 0 the same none, 1 the same window, 2 another
void margin_page_set_hosted_frame(MarginPage *page, const MarginRect *frame); // NULL: unread
bool margin_page_set_visible(MarginPage *page, const MarginShown *list, size_t len); // true: more than their rects changed
void margin_page_set_frames(MarginPage *page, const MarginFrame *list, size_t len);
bool margin_page_set_following(MarginPage *page, bool on);
void margin_page_settle(MarginPage *page, double now, MarginSettled *out);
void margin_page_grace_over(MarginPage *page, MarginSettled *out);
void margin_page_place_hole(MarginPage *page, MarginRect content, MarginHolePlaced *out);
void margin_page_read(const MarginPage *page, MarginPageRead *out);
ptrdiff_t margin_page_text(const MarginPage *page, uint8_t which, uint8_t *buf, size_t cap); // 0 loader, 1 loader's app, 2 slow step, 3 show, 4 stuck; -1: none
// What the page said (core/page/said.rs): an op and its body's JSON (a layout's: its report) → its route (`kind`: 0
// nothing, 1 ready, 2 layout (flag taken, flag2 panes changed), 3 the card's rect (has_rect, rect), 4 hits (flag all;
// `rects` of them), 5 chrome (has_rect: controls; drags as rects), 6 focus (flag), 7 counts (a, b), 8 the pointer's
// wants, 9 full screen, 10 resizing (flag on, flag2 divider), 11 haptic, 12 slide (a side; text item), 13 ask (text
// `{ name, arg }`), 14 log (flag warn; text)); `text` freed with margin_buffer_free. `said_rects`: the rects it read.
// The hello: its JSON text (freed with margin_buffer_free).
typedef struct MarginSaid { uint8_t kind; bool flag; bool flag2; bool has_rect; int64_t a; int64_t b; MarginRect rect; size_t rects; uint8_t *text; size_t text_len; } MarginSaid;
typedef struct MarginHelloFacts {
    int64_t window_id; double page_minimum;
    MarginBytes browser; MarginBytes mode; MarginBytes state; MarginBytes windows; MarginBytes themes; MarginBytes apps;
    MarginBytes margin_page; MarginBytes pane_min; MarginBytes app_min; MarginBytes pane_loading; MarginBytes pane_cut;
    MarginBytes picture; MarginBytes hosted_frame; MarginBytes hosted_frames; MarginBytes theme;
} MarginHelloFacts;
uint8_t margin_page_said(MarginPage *page, const uint8_t *op, size_t op_len, const uint8_t *body, size_t body_len, MarginRect content, MarginSaid *out);
size_t margin_page_said_rects(const MarginPage *page, MarginRect *out, size_t cap);
uint8_t *margin_page_hello(const MarginPage *page, const MarginHelloFacts *facts, size_t *out_len);
void margin_page_pointer_want(const uint8_t *body, size_t len, uint8_t *mode, uint8_t *bits, double *zone); // mode 0 none, 1 edges, 2 all
size_t margin_page_holes(const MarginPage *page, MarginRect *out, size_t cap);
size_t margin_page_pane_holes(const MarginPage *page, MarginPaneHole *out, size_t cap);
bool margin_page_frame(const MarginPage *page, int64_t window, MarginRect *out);
bool margin_page_set_yielding(MarginPage *page, bool has, int64_t number);
bool margin_page_set_covering(MarginPage *page, bool has, int64_t number);
void margin_page_space_changed(MarginPage *page, double now);
void margin_page_keep_front(MarginPage *page, int64_t level, void *ctx, MarginClock now, MarginKeepFront *out);
bool margin_page_front_reads(const MarginPage *page, int64_t hosted);
void margin_page_front_read(MarginPage *page, int64_t hosted, int64_t layer, bool above, int64_t level, void *ctx, MarginClock now, MarginFrontOps *out);
bool margin_page_rect(MarginInsets insets, double width, double height, MarginRect content, MarginRect *out);
bool margin_page_measured_at(double width, double height, MarginRect content);
bool margin_page_narrowed(bool full_screen, MarginRect content, const MarginRect *display); // display NULL: none
bool margin_page_fill_color(const uint8_t *css, size_t len, MarginRgba *out);
bool margin_page_fill_common(const MarginRgba *list, size_t len, MarginRgba *out);
size_t margin_page_subtract(MarginRect r, MarginRect cut, MarginRect *out); // room for 4
typedef struct MarginPiece {
    MarginRect rect;
    size_t from; // the hole it's of
    bool whole;
} MarginPiece;
size_t margin_page_ground_holes(const MarginRect *list, size_t len, MarginPiece *out, size_t cap); // more than cap: none written

#endif
